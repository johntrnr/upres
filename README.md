# Upres

Tiled creative upscaler and photo restorer. Monochrome, phone-first PWA on Netlify, models on Replicate.

## Pipeline

| Stage | What it does | Replicate models |
|---|---|---|
| Restore | Repairs damage, colorizes, or rebuilds an old photo as a modern realistic one | `google/nano-banana-pro` · `black-forest-labs/flux-kontext-pro` · `black-forest-labs/flux-kontext-max` · `flux-kontext-apps/restore-image` |
| Upscale | Faithful base enlargement (half the final size when Magnify is on) | `zsxkib/seedvr2` (3B/7B) · `philz1337x/crystal-upscaler` · local resize |
| Magnify | Splits the base into evenly sized overlapping tiles; FLUX img2img re-renders each tile at about 1 MP; tiles are colour-locked to the base and feather-blended | `black-forest-labs/flux-krea-dev` · `black-forest-labs/flux-dev` |
| Finish | Sharpen, clarity, grain, looks, on device (Web Workers) | none |

Restore and Upscale results are cached per image and settings, so tuning Magnify only pays for tiles. The Run button shows a cost estimate; **Preview** magnifies the single tile at the centre of the view.

## Setup

1. Deploy on Netlify from this repo (no build command; publish `public`, functions in `netlify/functions`).
2. Create a token at https://replicate.com/account/api-tokens and add billing.
3. In the app: ⋯ → Replicate token → paste → Connect. The token stays on the device and is only sent to this site's `/api/rep` function.

Optional server-held token: set `REPLICATE_API_TOKEN` and `UPRES_PASSCODE` in Netlify; requests sending the passcode in `x-upres-pass` use it.

## How inputs reach the models

The app sends semantic inputs (`image`, `prompt`, `strength`, `steps`, `guidance`, `scale`, ...). `/api/rep` reads each model's live OpenAPI schema from Replicate and maps them to the model's real field names, enums and ranges (for example `image` → `image_input[]`, `input_image` or `media`). Official models run through the model endpoint; community models fall back to their latest version.

## Endpoints

- `POST /api/rep` `{ model, input }` — start a prediction on an allow-listed model
- `GET /api/rep?id=…` — status, progress, output · `DELETE /api/rep?id=…` — cancel
- `GET /api/rep?check=1` — token check
- `GET /api/img?u=…` — streams a replicate.delivery image back same-origin
