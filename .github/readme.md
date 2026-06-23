# AOCR-X

> [!WARNING]
> All improvements in this fork were vibe coded, and I barely know what the code is doing. Run it at your own risk. Durable improvements should be made in the upstream repository: <https://github.com/SomeAspy/AOCR>.

> Enhance Discord's automod with image recognition - Works on emojis, reactions, stickers, and more!

<img width="635" height="748" alt="image" src="https://github.com/user-attachments/assets/df80d735-58e0-4243-88e1-672316d55b2f" />

## Changes in AOCR-X

- Added pluggable OCR engine support with the original Tesseract path, PaddleOCR HTTP requests, timeouts, and fallback controls.
- Added a PaddleOCR sidecar service with Docker setup, health checks, CPU thread configuration, image normalization, and GIF/video first-frame handling.
- Added a Tesseract non-SIMD postinstall patch for hosts where the default WASM core fails.
- Added OCR deduplication and richer media collection for attachments, embeds, stickers, custom emojis, and reactions.
- Added recurrent spam wave tracking shared by OCR detections and classic repeated-text spam.
- Added a classic repeated-text spam detector with delete, timeout, ban, DM, alert-channel, and cross-user matching controls.
- Added quieter default alerts when `DEBUG_AOCR=false`, while keeping detailed embeds/logs available for debugging.

## Self-Hosting

There is no public AOCR-X bot invite. Create and run your own Discord bot.

### 1. Create a Discord application

1. Open the Discord Developer Portal and create a new application.
2. Go to **Bot** and create a bot user.
3. Enable **Message Content Intent**. Without this, OCR emoji checks and repeated-text spam checks cannot inspect message content.
4. Copy the bot token and put it in `.env` as `DISCORD_TOKEN`.

### 2. Invite your bot to your server

Use the OAuth2 URL Generator for your own application:

- Scope: `bot`
- Bot permissions:
    - View Channels
    - Send Messages
    - Manage Messages
    - Manage Server
    - Moderate Members
    - Read Message History

Open the generated URL and add the bot to your server.

### 3. Configure Discord AutoMod

AOCR-X reads your server's AutoMod keyword and regex rules, runs OCR on images/media, and applies the matching AutoMod actions when recognized text matches those rules.

Create or update AutoMod rules in Discord before starting the bot:

- Use keyword filters and regex patterns for the text you want to detect in images.
- Add a **Send Alert Message** action if you want AOCR-X OCR detections to post alert embeds to a channel.
- Add **Block Message** if the bot should delete offending messages or remove offending reactions.
- Add **Timeout User** if matching users should be timed out.

Example regex patterns:

```regex
https://steamescommnunity\.com/s/\d+
\b(?:gift|bonus|promo|activate|offer|reward|claim|clain)\b
\b(?:nsfw|nudes|onlyfans|porn|sexo|pussy|s3xcam|sexcam)\b
\b(?:brhots|MrBeast|beast|casino|bloxshop|robux)\b
```

Members with **Manage Server** can be skipped by setting `APPLY_TO_MODERATORS=false`.

### 4. Clone and configure AOCR-X

```sh
git clone https://github.com/Xalalau/AOCR-X
cd AOCR-X
cp .env.example .env
```

Edit `.env`:

- `DISCORD_TOKEN`: Your bot token.
- `DEBUG_AOCR`: `true` for verbose logs and full alert embeds; `false` for quieter alerts.
- `APPLY_TO_MODERATORS`: Apply checks to members with Manage Server when `true`.
- `SEND_DETECTION_DM`: DM detected users when `true`.
- `OCR_ENGINE`: Use `tesseract` for the built-in engine or `paddle` for the sidecar service.
- `OCR_CHECK_EMOJIS`, `OCR_CHECK_REACTIONS`, `OCR_CHECK_STICKERS`: Enable OCR checks for those Discord surfaces.
- `OCR_START_DELAY_SECONDS`: Delay OCR so repeated-text spam cleanup can happen first.
- `TEXT_SPAM_*`: Configure repeated-text spam detection, deletion, timeout/ban behavior, and alert routing.
- `SPAM_RECURRENT_*`: Track repeated spam waves across OCR and repeated-text detections.

If you do not want to run the PaddleOCR sidecar, set:

```env
OCR_ENGINE=tesseract
```

### 5. Optional: run the PaddleOCR sidecar

PaddleOCR usually recognizes text better than Tesseract, but it runs as a separate local HTTP service.

```sh
docker build -t aocr-x-paddle ./paddle-ocr-service
docker run -d --name aocr-x-paddle --restart unless-stopped -p 127.0.0.1:8000:8000 aocr-x-paddle
wget -qO- http://127.0.0.1:8000/health; echo
```

Then keep these values in `.env`:

```env
OCR_ENGINE=paddle
OCR_PADDLE_URL=http://127.0.0.1:8000/ocr
OCR_PADDLE_FALLBACK_TO_TESSERACT=true
OCR_PADDLE_SEND_IMAGE_BASE64=true
OCR_PADDLE_FALLBACK_ON_EMPTY_TEXT=true
```

More PaddleOCR details are in `paddle-ocr-service/README.md`.

### 6. Install, build, and run

```sh
pnpm install
pnpm build
pnpm start
```

For development:

```sh
pnpm dev
```

### OCR powered by [Tesseract.js](https://tesseract.projectnaptha.com/) or [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

#### Training data provided by <https://github.com/tesseract-ocr/tessdata_best/blob/main/eng.traineddata>
