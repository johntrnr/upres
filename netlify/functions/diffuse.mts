import type { Config } from "@netlify/functions"

// Proxy between the Upres app and Replicate's Clarity Upscaler (Stable Diffusion tiled upscaling).
// GET  /api/diffuse?schema=1   -> live input schema (enums, ranges) of the latest model version
// POST /api/diffuse            -> start a prediction { image: dataURL, input: {...} }
// GET  /api/diffuse?id=<id>    -> prediction status / output
// DELETE /api/diffuse?id=<id>  -> cancel a prediction
//
// Auth: the app sends the user's own Replicate token in `x-replicate-token`.
// Optional server-held token: set REPLICATE_API_TOKEN and UPRES_PASSCODE in Netlify;
// the app then sends the passcode in `x-upres-pass`. Without both, the server token is never used.

const API = "https://api.replicate.com/v1"
const MODEL = "philz1337x/clarity-upscaler"
const BLOCKED_INPUTS = new Set(["image", "mask", "lora_links", "custom_sd_model"])
const MAX_IMAGE_CHARS = 4_500_000

type Spec = { type?: string; default?: unknown; enum?: unknown[]; min?: number; max?: number; description?: string; order?: number; title?: string }
let cache: { version: string; inputs: Record<string, Spec>; at: number } | null = null

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

function tokenFrom(req: Request): string | null {
  const own = req.headers.get("x-replicate-token")?.trim()
  if (own) return own
  const env = Netlify.env.get("REPLICATE_API_TOKEN")
  const pass = Netlify.env.get("UPRES_PASSCODE")
  if (env && pass && req.headers.get("x-upres-pass") === pass) return env
  return null
}

async function rep(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  })
  let body: any = null
  try { body = await r.json() } catch { /* empty body */ }
  if (!r.ok) {
    const detail = body?.detail || body?.title || `Replicate returned ${r.status}`
    if (r.status === 401) throw new HttpError(401, "bad_token", "Replicate rejected the token. Check it in the Model step.")
    if (r.status === 402) throw new HttpError(402, "billing", "Your Replicate account needs credit or a payment method (replicate.com/account/billing).")
    if (r.status === 422) throw new HttpError(422, "invalid_input", String(detail))
    if (r.status === 429) throw new HttpError(429, "rate_limited", "Replicate is rate limiting this account. Wait a moment and try again.")
    throw new HttpError(502, "replicate_error", String(detail))
  }
  return body
}

async function getModel(token: string) {
  if (cache && Date.now() - cache.at < 6 * 3600_000) return cache
  const m = await rep(`/models/${MODEL}`, token)
  const lv = m?.latest_version
  if (!lv?.id) throw new HttpError(502, "no_version", "Could not find the latest Clarity Upscaler version.")
  const comps: Record<string, any> = lv.openapi_schema?.components?.schemas || {}
  const props: Record<string, any> = comps.Input?.properties || {}
  const inputs: Record<string, Spec> = {}
  for (const [k, raw] of Object.entries(props)) {
    let p: any = { ...raw }
    const ref: string | undefined = p.allOf?.[0]?.$ref || p.$ref
    if (ref) { const name = ref.split("/").pop() as string; p = { ...(comps[name] || {}), ...p } }
    inputs[k] = { type: p.type, default: p.default, enum: p.enum, min: p.minimum, max: p.maximum, description: p.description, order: p["x-order"], title: p.title }
  }
  cache = { version: lv.id, inputs, at: Date.now() }
  return cache
}

function clean(raw: Record<string, unknown>, inputs: Record<string, Spec>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw || {})) {
    const spec = inputs[k]
    if (!spec || BLOCKED_INPUTS.has(k) || v === null || v === undefined || v === "") continue
    if (spec.enum) { const hit = spec.enum.find(e => String(e) === String(v)); if (hit !== undefined) out[k] = hit; continue }
    if (spec.type === "number" || spec.type === "integer") {
      let n = Number(v)
      if (!Number.isFinite(n)) continue
      if (typeof spec.min === "number") n = Math.max(spec.min, n)
      if (typeof spec.max === "number") n = Math.min(spec.max, n)
      out[k] = spec.type === "integer" ? Math.round(n) : n
      continue
    }
    if (spec.type === "boolean") { out[k] = v === true || v === "true"; continue }
    if (spec.type === "string") out[k] = String(v).slice(0, 2000)
  }
  return out
}

function progressOf(logs: unknown): number | null {
  if (typeof logs !== "string") return null
  const all = [...logs.matchAll(/(\d{1,3})%\|/g)]
  if (!all.length) return null
  return Math.min(100, Number(all[all.length - 1][1]))
}

const slim = (p: any) => ({
  id: p.id,
  status: p.status,
  output: Array.isArray(p.output) ? p.output : p.output ? [p.output] : [],
  error: p.error || null,
  progress: progressOf(p.logs),
  predictTime: p.metrics?.predict_time ?? null,
})

export default async (req: Request) => {
  try {
    const url = new URL(req.url)
    const token = tokenFrom(req)
    if (!token) return json({ error: "no_token", message: "Add your Replicate API token in the Model step." }, 401)

    if (req.method === "GET" && url.searchParams.has("schema")) {
      const account = await rep("/account", token) // verifies this token, even when the schema is cached
      const m = await getModel(token)
      return json({ model: MODEL, version: m.version, inputs: m.inputs, account: account?.username || null })
    }

    const id = url.searchParams.get("id")
    if (id && !/^[a-z0-9]{8,64}$/i.test(id)) return json({ error: "bad_id", message: "Invalid prediction id." }, 400)

    if (req.method === "GET" && id) return json(slim(await rep(`/predictions/${id}`, token)))

    if (req.method === "DELETE" && id) return json(slim(await rep(`/predictions/${id}/cancel`, token, { method: "POST" })))

    if (req.method === "POST") {
      let body: any
      try { body = await req.json() } catch { return json({ error: "bad_json", message: "Request body must be JSON." }, 400) }
      const image = body?.image
      if (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) return json({ error: "bad_image", message: "Send the image as a JPEG, PNG or WebP data URL." }, 400)
      if (image.length > MAX_IMAGE_CHARS) return json({ error: "too_large", message: "The input image is too large. Lower the input size." }, 413)
      const m = await getModel(token)
      const input = { ...clean(body.input || {}, m.inputs), image }
      const p = await rep("/predictions", token, { method: "POST", body: JSON.stringify({ version: m.version, input }) })
      return json(slim(p), 201)
    }

    return json({ error: "method", message: "Unsupported request." }, 405)
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status)
    return json({ error: "server", message: "The upscale server hit an unexpected error." }, 500)
  }
}

export const config: Config = { path: "/api/diffuse", method: ["GET", "POST", "DELETE"] }
