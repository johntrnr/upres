# Upres

Tiled creative upscaler and photo restorer. Monochrome, phone-first PWA on Netlify, models on fal.ai.

## Pipeline

| Stage | What it does | Models (fal.ai) |
|---|---|---|
| Restore | Repairs damage, colorizes, or rebuilds an old photo as a modern realistic one | Nano Banana Pro edit · FLUX.1 Kontext Pro · FLUX.1 Kontext Max |
| Upscale | Faithful base enlargement to the final size (half of it when Magnify is on) | SeedVR2 · Crystal Upscaler · local resize |
| Magnify | Splits the base into evenly sized, overlapping tiles; FLUX Vision Upscaler captions and re-renders each tile at 2×; tiles are colour-locked to the base and feather-blended | FLUX Vision Upscaler |
| Finish | Sharpen, clarity, grain, looks, on device (Web Workers) | none |

Restore and Upscale results are cached per image and settings, so tuning Magnify only pays for the tiles. The Run button shows a cost estimate; **Preview** magnifies the single tile at the centre of the view.

## Setup

1. Deploy on Netlify from this repo (no build command; publish `public`, functions in `netlify/functions`).
2. Create a key at https://fal.ai/dashboard/keys and add credit.
3. In the app: ⋯ → fal.ai key → paste → Connect. The key stays on the device and is only sent to this site's `/api/fal` function.

Optional server-held key: set `FAL_KEY` and `UPRES_PASSCODE` in Netlify; requests that send the passcode in `x-upres-pass` use it.

## Endpoints

- `POST /api/fal` `{ model, input }` — submit to an allow-listed fal model
- `GET /api/fal?status=<url>` / `?result=<url>` — queue status (with logs) and result
- `DELETE /api/fal?cancel=<url>` — cancel
- `GET /api/fal?check=1` — key check
- `GET /api/img?u=<url>` — streams a fal.media image back same-origin
