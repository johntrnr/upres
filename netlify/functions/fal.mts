import type { Config } from "@netlify/functions"

// Proxy between the Upres app and fal.ai's queue API.
// POST   /api/fal                    { model, input }  -> submit to an allowed model
// GET    /api/fal?status=<url>       -> queue status (with logs)
// GET    /api/fal?result=<url>       -> result payload
// DELETE /api/fal?cancel=<url>       -> cancel a queued / running request
// GET    /api/fal?check=1            -> verifies the key
//
// Auth: the app sends the user's own fal key in `x-fal-key`.
// Optional server-held key: set FAL_KEY and UPRES_PASSCODE in Netlify; the app then sends
// the passcode in `x-upres-pass`. Without both variables, no server key is ever used.

const QUEUE = "https://queue.fal.run"
const MODELS = new Set([
  "fal-ai/nano-banana-pro/edit",
  "fal-ai/flux-pro/kontext",
  "fal-ai/flux-pro/kontext/max",
  "fal-ai/seedvr/upscale/image",
  "clarityai/crystal-upscaler",
  "fal-ai/flux-vision-upscaler",
])
const MAX_BODY = 5_800_000

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

function keyFrom(req: Request): string | null {
  const own = req.headers.get("x-fal-key")?.trim()
  if (own) return own
  const env = Netlify.env.get("FAL_KEY")
  const pass = Netlify.env.get("UPRES_PASSCODE")
  if (env && pass && req.headers.get("x-upres-pass") === pass) return env
  return null
}

function queueUrl(raw: string | null): URL | null {
  try {
    const u = new URL(raw || "")
    return u.protocol === "https:" && u.hostname === "queue.fal.run" ? u : null
  } catch { return null }
}

function messageOf(body: any, status: number): string {
  const d = body?.detail
  if (typeof d === "string") return d
  if (Array.isArray(d) && d.length) return d.map((x: any) => [x?.loc?.slice?.(-1)?.[0], x?.msg].filter(Boolean).join(": ")).join("; ")
  if (typeof body?.error === "string") return body.error
  if (typeof body?.message === "string") return body.message
  return `fal returned ${status}`
}

async function fal(url: string, key: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", ...(init.headers || {}) } })
  let body: any = null
  try { body = await r.json() } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return json({ error: "bad_key", message: "fal rejected the key. Check it in Account." }, 401)
    if (r.status === 402) return json({ error: "billing", message: "Your fal account is out of credit. Add credit at fal.ai/dashboard/billing." }, 402)
    if (r.status === 429) return json({ error: "rate_limited", message: "fal is rate limiting this account. Wait a moment and try again." }, 429)
    return json({ error: r.status === 422 ? "invalid_input" : "fal_error", message: messageOf(body, r.status) }, r.status >= 500 ? 502 : r.status)
  }
  return json(body ?? {})
}

export default async (req: Request) => {
  try {
    const url = new URL(req.url)
    const key = keyFrom(req)
    if (!key) return json({ error: "no_key", message: "Add your fal API key in Account." }, 401)

    if (req.method === "GET" && url.searchParams.has("check")) {
      // A status lookup for a request id that cannot exist: 401/403 means a bad key, anything else means the key works.
      const r = await fetch(`${QUEUE}/fal-ai/seedvr/requests/00000000-0000-4000-8000-000000000000/status`, { headers: { Authorization: `Key ${key}` } })
      if (r.status === 401 || r.status === 403) return json({ error: "bad_key", message: "fal rejected the key. Check it in Account." }, 401)
      return json({ ok: true })
    }

    if (req.method === "GET" && url.searchParams.has("status")) {
      const u = queueUrl(url.searchParams.get("status"))
      if (!u) return json({ error: "bad_url", message: "Invalid status URL." }, 400)
      u.searchParams.set("logs", "1")
      return fal(u.toString(), key)
    }

    if (req.method === "GET" && url.searchParams.has("result")) {
      const u = queueUrl(url.searchParams.get("result"))
      if (!u) return json({ error: "bad_url", message: "Invalid result URL." }, 400)
      return fal(u.toString(), key)
    }

    if (req.method === "DELETE" && url.searchParams.has("cancel")) {
      const u = queueUrl(url.searchParams.get("cancel"))
      if (!u) return json({ error: "bad_url", message: "Invalid cancel URL." }, 400)
      return fal(u.toString(), key, { method: "PUT" })
    }

    if (req.method === "POST") {
      const len = Number(req.headers.get("content-length") || 0)
      if (len > MAX_BODY) return json({ error: "too_large", message: "The image is too large to send. Lower the input size." }, 413)
      let body: any
      try { body = await req.json() } catch { return json({ error: "bad_json", message: "Request body must be JSON." }, 400) }
      const model = String(body?.model || "")
      if (!MODELS.has(model)) return json({ error: "bad_model", message: "That model is not enabled in Upres." }, 400)
      const input = body?.input
      if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "bad_input", message: "Missing model input." }, 400)
      return fal(`${QUEUE}/${model}`, key, { method: "POST", body: JSON.stringify(input) })
    }

    return json({ error: "method", message: "Unsupported request." }, 405)
  } catch {
    return json({ error: "server", message: "The Upres server hit an unexpected error." }, 500)
  }
}

export const config: Config = { path: "/api/fal", method: ["GET", "POST", "DELETE"] }
