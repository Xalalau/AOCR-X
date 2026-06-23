# FAQ.md

## Why isn't the bot working?

The bot will not apply automod rules to members with `Administrator` or `Manage Server`. This is the same behavior you will get from regular automod.

If you are self hosting you can change this in the `.env` file by setting `APPLY_TO_MODERATORS` to `true`

## Why doesn't the bot catch everything?

OCR is not perfect. There are serious gaps in recognition. OCR works best on clear/clean text.

This bot using [Tesseract.js](<https://github.com/naptha/tesseract.js>) with the [English tessdata_best training model (direct download)](https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata).

## Where can I change settings?

Most moderation behavior comes from your server's automod configuration. Self-hosted installs can also change runtime options in the `.env` file.

Set `SEND_DETECTION_DM=true` to send a private DM to the detected member. When this is `false` or unset, AOCR-X will not DM the detected member. AutoMod alert messages are sent only to the alert channel configured in the matching AutoMod rule.

For the classic repeated-text spam detector, set `TEXT_SPAM_ALERT_CHANNEL_ID` to one channel ID to send every server's alerts to the same place, or use `server_id:channel_id,server_id:channel_id` to route alerts per server. You can also include `default:channel_id` as a fallback for servers not listed in the mapping.

## OK, but I *really* want to disable certain aspects

You can self host the bot via the directions on the [GitHub readme](https://github.com/Xalalau/AOCR-X). Run this fork at your own risk; durable improvements should go upstream.
