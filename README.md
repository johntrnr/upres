# Upres

Tiled creative upscaler PWA. Monochrome, phone-first.

- **Clarity diffusion** (cloud): Stable Diffusion tiled upscaling via Replicate's `philz1337x/clarity-upscaler`, billed to your Replicate account (about $0.02 a run).
- **Real-ESRGAN** General / Anime (on device): runs on the phone GPU with TensorFlow.js, free and offline.
- Local tile pipeline after either model: Enhance, Color, Creative (detail, painterly, ink, glitch), feather-blended seams.

## Setup

1. Deploy on Netlify from this repo. No build command; publish directory is `public`, functions live in `netlify/functions`.
2. Open the site, go to **Model → Clarity diffusion**, paste a Replicate API token from https://replicate.com/account/api-tokens and tap **Connect**.
3. On iPhone: Share → Add to Home Screen for the full-screen app.

The token is stored only on your device and sent to your own `/api/diffuse` function, which forwards it to Replicate.

### Optional: server-held token

Set `REPLICATE_API_TOKEN` and `UPRES_PASSCODE` as environment variables in Netlify (Functions scope). Requests that send the passcode in the `x-upres-pass` header use the server token. Without both variables set, no server token is ever used.

## Endpoints

- `GET /api/diffuse?schema=1` — verifies the token and returns the model's live input schema
- `POST /api/diffuse` — `{ image: dataURL, input: {...} }` starts a prediction (inputs are validated against the schema)
- `GET /api/diffuse?id=…` — status, progress and output
- `DELETE /api/diffuse?id=…` — cancel
- `GET /api/img?u=…` — streams a finished `replicate.delivery` image back same-origin
