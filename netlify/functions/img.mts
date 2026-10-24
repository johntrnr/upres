import type { Config } from "@netlify/functions"

// Streams a finished fal output image back to the app (same origin, so it can be drawn
// to a canvas and saved). Only fal's media hosts are allowed.
const ALLOWED = [/(^|\.)fal\.media$/, /^storage\.googleapis\.com$/, /(^|\.)fal\.run$/, /(^|\.)fal\.ai$/]

export default async (req: Request) => {
  const u = new URL(req.url).searchParams.get("u")
  let target: URL
  try { target = new URL(u || "") } catch { return new Response("Bad url", { status: 400 }) }
  if (target.protocol !== "https:" || !ALLOWED.some(r => r.test(target.hostname))) return new Response("Host not allowed", { status: 403 })
  const r = await fetch(target)
  if (!r.ok || !r.body) return new Response("Image not available", { status: 502 })
  return new Response(r.body, {
    headers: { "content-type": r.headers.get("content-type") || "image/png", "cache-control": "private, max-age=3600" },
  })
}

export const config: Config = { path: "/api/img", method: "GET" }
