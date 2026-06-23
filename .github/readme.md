# AOCR-X

> [!WARNING]
> All improvements in this fork were vibe coded, and I barely know what the code is doing. Run it at your own risk. Durable improvements should be made in the upstream repository: <https://github.com/SomeAspy/AOCR>.

> Enhance Discord's automod with image recognition - Works on emojis, reactions, stickers, and more!

![Video Demo](https://github.com/SomeAspy/AOCR/assets/33640860/4d8be2f5-ce98-4b92-bfe6-88424ab23c99)

## Changes in AOCR-X

- Added pluggable OCR engine support with the original Tesseract path, PaddleOCR HTTP requests, timeouts, and fallback controls.
- Added a PaddleOCR sidecar service with Docker setup, health checks, CPU thread configuration, image normalization, and GIF/video first-frame handling.
- Added a Tesseract non-SIMD postinstall patch for hosts where the default WASM core fails.
- Added OCR deduplication and richer media collection for attachments, embeds, stickers, custom emojis, and reactions.
- Added recurrent spam wave tracking shared by OCR detections and classic repeated-text spam.
- Added a classic repeated-text spam detector with delete, timeout, ban, DM, alert-channel, and cross-user matching controls.
- Added quieter default alerts when `DEBUG_AOCR=false`, while keeping detailed embeds/logs available for debugging.

## Invite

<https://discord.com/api/oauth2/authorize?client_id=1168700227201548409&permissions=1099511639072&scope=bot>

> [!IMPORTANT]
> The production bot does not apply automod rules to admins/users with manage server, similar to standard automod

## To Host Yourself

1. Create a discord bot with the following permissions ([Detailed guide from Discord.JS](https://discordjs.guide/preparations/setting-up-a-bot-application.html)):
    - ***ENABLE THE MESSAGE CONTENT INTENT***
    - Send Messages (To send messages to the automod channel)
    - Manage Messages (To delete offending messages)
    - Manage Server (To view AutoMod rules)
    - Read Messages/View Channels (To view messages and images contained within)
    - Moderate Members (To apply moderation actions to members)
2. Add the bot to your server
3. Clone this repository (`git clone https://github.com/Xalalau/AOCR-X`)
4. Set configs in `.env` (copy `.env.example` and rename the copy to `.env`)
    - `DISCORD_TOKEN`: This will be your bot's Discord token.
    - `DEBUG_AOCR`: Enable detailed logs and full alert embeds.
    - `APPLY_TO_MODERATORS`: Whether to apply AOCR-X detection to admins and members with Manage Server.
    - `SEND_DETECTION_DM`: Whether to DM detected users.
    - `OCR_ENGINE`: Select `tesseract` or the optional `paddle` sidecar service.
    - `OCR_TESSERACT_WORKERS`: Worker count for Tesseract OCR.
    - `OCR_CHECK_EMOJIS`, `OCR_CHECK_REACTIONS`, `OCR_CHECK_STICKERS`: Enable image checks for each Discord surface.
    - `TEXT_SPAM_*`: Configure the classic repeated-text spam detector.
    - `SPAM_RECURRENT_*`: Configure recurrent spam wave tracking shared by OCR and text spam.
    - For PaddleOCR sidecar setup, see `paddle-ocr-service/README.md`.
5. Install packages using a node package manager (I suggest [PNPM](https://pnpm.io/)): `pnpm i`
6. Build: `pnpm build`
7. Run: `pnpm start`

### OCR powered by [Tesseract.js](https://tesseract.projectnaptha.com/) or [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

#### Training data provided by <https://github.com/tesseract-ocr/tessdata_best/blob/main/eng.traineddata>
