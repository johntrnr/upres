import type { Config } from "@netlify/functions"

// Proxy between the Upres app and Replicate.
// POST   /api/rep            { model, input }  -> start a prediction on an allow-listed model
// GET    /api/rep?id=<id>    -> status, progress, output
// DELETE /api/rep?id=<id>    -> cancel
// GET    /api/rep?check=1    -> verifies the token
//
// The app sends "semantic" inputs (image, prompt, strength, steps, guidance, scale...).
// This function reads each model's live input schema from Replicate and maps those onto
// the model's real field names, enums and ranges, so schema changes on Replicate's side
// don't break the app.
//
// Auth: the app sends the user's own token in `x-replicate-token`.
// Optional server token: set REPLICATE_API_TOKEN and UPRES_PASSCODE; the app then sends the
// passcode in `x-upres-pass`. Without both, no server token is ever used.

const API = "https://api.replicate.com/v1"
const MODELS = new Set([
  "google/nano-banana-pro",
  "black-forest-labs/flux-kontext-pro",
  "black-forest-labs/flux-kontext-max",
  "flux-kontext-apps/restore-image",
  "zsxkib/seedvr2",
  "philz1337x/crystal-upscaler",
  "black-forest-labs/flux-krea-dev",
  "black-forest-labs/flux-dev",
])
const MAX_BODY = 5_800_000

// semantic key -> candidate field names, first match in the schema wins
const ALIASES: Record<string, string[]> = {
  image: ["image_input", "input_image", "image", "media", "input", "img"],
  prompt: ["prompt"],
  strength: ["prompt_strength", "strength", "denoise", "denoising_strength"],
  steps: ["num_inference_steps", "steps", "sample_steps"],
  guidance: ["guidance", "guidance_scale", "cfg_scale", "cfg"],
  scale: ["scale_factor", "upscale_factor", "scale", "upscale"],
  creativity: ["creativity"],
  seed: ["seed"],
  resolution: ["resolution"],
  megapixels: ["megapixels"],
  variant: ["model_variant"],
  colorfix: ["apply_color_fix", "color_fix"],
}

type Spec = { type?: string; items?: any; enum?: unknown[]; min?: number; max?: number; default?: unknown }
type Info = { version: string | null; inputs: Record<string, Spec>; at: number }
const cache = new Map<string, Info>()

class HttpError extends Error { constructor(public status: number, public code: string, msg: string) { super(msg) } }
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

async function rep(path: string, token: string, init: RequestInit = {}, raw = false) {
  const r = await fetch(API + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } })
  let body: any = null
  try { body = await r.json() } catch { /* empty */ }
  if (raw) return { ok: r.ok, status: r.status, body }
  if (!r.ok) throw toError(r.status, body)
  return body
}
function toError(status: number, body: any) {
  const detail = String(body?.detail || body?.title || `Replicate returned ${status}`)
  if (status === 401) return new HttpError(401, "bad_token", "Replicate rejected the token. Check it in Account.")
  if (status === 402) return new HttpError(402, "billing", "Your Replicate account needs credit or a payment method (replicate.com/account/billing).")
  if (status === 429) return new HttpError(429, "rate_limited", "Replicate is rate limiting this account. Wait a moment and try again.")
  if (status === 422) return new HttpError(422, "invalid_input", detail)
  if (status === 404) return new HttpError(404, "not_found", detail)
  return new HttpError(502, "replicate_error", detail)
}

async function modelInfo(model: string, token: string): Promise<Info> {
  const hit = cache.get(model)
  if (hit && Date.now() - hit.at < 3 * 3600_000) return hit
  const m = await rep(`/models/${model}`, token)
  const lv = m?.latest_version
  const comps: Record<string, any> = lv?.openapi_schema?.components?.schemas || {}
  const props: Record<string, any> = comps.Input?.properties || {}
  const inputs: Record<string, Spec> = {}
  for (const [k, raw] of Object.entries(props)) {
    let p: any = { ...raw }
    const ref: string | undefined = p.allOf?.[0]?.$ref || p.$ref
    if (ref) p = { ...(comps[ref.split("/").pop() as string] || {}), ...p }
    inputs[k] = { type: p.type, items: p.items, enum: p.enum, min: p.minimum, max: p.maximum, default: p.default }
  }
  const info = { version: lv?.id || null, inputs, at: Date.now() }
  cache.set(model, info)
  return info
}

function coerce(spec: Spec, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return undefined
  if (spec.enum) {
    const hit = spec.enum.find(e => String(e) === String(v))
    if (hit !== undefined) return hit
    const lower = spec.enum.find(e => String(e).toLowerCase() === String(v).toLowerCase())
    return lower
  }
  if (spec.type === "number" || spec.type === "integer") {
    let n = Number(v)
    if (!Number.isFinite(n)) return undefined
    if (typeof spec.min === "number") n = Math.max(spec.min, n)
    if (typeof spec.max === "number") n = Math.min(spec.max, n)
    return spec.type === "integer" ? Math.round(n) : n
  }
  if (spec.type === "boolean") return v === true || v === "true"
  if (spec.type === "array") return Array.isArray(v) ? v : [v]
  return typeof v === "string" ? v.slice(0, 4000) : v
}

function mapInput(semantic: Record<string, unknown>, inputs: Record<string, Spec>) {
  const out: Record<string, unknown> = {}
  const has = Object.keys(inputs).length > 0
  for (const [key, val] of Object.entries(semantic)) {
    const names = ALIASES[key] || [key]
    const field = has ? names.find(n => inputs[n]) : names[0]
    if (!field) continue
    const v = has ? coerce(inputs[field], val) : val
    if (v !== undefined) out[field] = v
  }
  if (has) {
    // Sensible fixed choices when the model offers them.
    const ar = inputs.aspect_ratio
    if (ar?.enum?.includes("match_input_image")) out.aspect_ratio = "match_input_image"
    const of = inputs.output_format
    if (of?.enum) out.output_format = of.enum.find(e => String(e) === "png") ?? of.enum[0]
    if (inputs.disable_safety_checker) out.disable_safety_checker = true
    if (inputs.safety_tolerance && typeof inputs.safety_tolerance.max === "number") out.safety_tolerance = Math.min(2, inputs.safety_tolerance.max)
    if (inputs.go_fast) out.go_fast = false
    if (inputs.output_quality) out.output_quality = 100
    if (inputs.num_outputs) out.num_outputs = 1
  }
  return out
}

function progressOf(logs: unknown): number | null {
  if (typeof logs !== "string") return null
  const all = [...logs.matchAll(/(\d{1,3})%\|/g)]
  return all.length ? Math.min(100, Number(all[all.length - 1][1])) : null
}
function outputs(o: unknown): string[] {
  if (typeof o === "string") return [o]
  if (Array.isArray(o)) return o.filter(x => typeof x === "string")
  if (o && typeof o === "object") return Object.values(o as object).filter(x => typeof x === "string" && /^https?:/.test(x)) as string[]
  return []
}
const slim = (p: any) => ({ id: p.id, status: p.status, output: outputs(p.output), error: p.error || null, progress: progressOf(p.logs), predictTime: p.metrics?.predict_time ?? null })

export default async (req: Request) => {
  try {
    const url = new URL(req.url)
    if (req.method === "GET" && url.searchParams.has("ping")) return json({ ok: true, server: "upres", time: Date.now() })
    const token = tokenFrom(req)
    if (!token) return json({ error: "no_token", message: "Add your Replicate token in Account." }, 401)

    if (req.method === "GET" && url.searchParams.has("check")) {
      const a = await rep("/account", token)
      return json({ ok: true, account: a?.username || null })
    }

    const id = url.searchParams.get("id")
    if (id !== null && !/^[a-z0-9]{8,64}$/i.test(id)) return json({ error: "bad_id", message: "Invalid prediction id." }, 400)
    if (req.method === "GET" && id) return json(slim(await rep(`/predictions/${id}`, token)))
    if (req.method === "DELETE" && id) return json(slim(await rep(`/predictions/${id}/cancel`, token, { method: "POST" })))

    if (req.method === "POST") {
      if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "too_large", message: "The image is too large to send. Lower the input size." }, 413)
      let body: any
      try { body = await req.json() } catch { return json({ error: "bad_json", message: "Request body must be JSON." }, 400) }
      const model = String(body?.model || "")
      if (!MODELS.has(model)) return json({ error: "bad_model", message: "That model is not enabled in Upres." }, 400)
      const semantic = body?.input
      if (!semantic || typeof semantic !== "object" || Array.isArray(semantic)) return json({ error: "bad_input", message: "Missing model input." }, 400)
      const info = await modelInfo(model, token)
      const input = mapInput(semantic, info.inputs)
      // Official models run through the model endpoint; community models need a version.
      let r = await rep(`/models/${model}/predictions`, token, { method: "POST", body: JSON.stringify({ input }) }, true)
      if (!r.ok && info.version && ![401, 402, 429].includes(r.status)) {
        r = await rep(`/predictions`, token, { method: "POST", body: JSON.stringify({ version: info.version, input }) }, true)
      }
      if (!r.ok) throw toError(r.status, r.body)
      return json(slim(r.body), 201)
    }
    return json({ error: "method", message: "Unsupported request." }, 405)
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status)
    return json({ error: "server", message: "The Upres server hit an unexpected error." }, 500)
  }
}

export const config: Config = { path: "/api/rep", method: ["GET", "POST", "DELETE"] }
