import { type Message, PermissionsBitField } from "discord.js";
import { claimOcrImage } from "../functions/ocrMemory.js";
import { processer } from "../functions/process.js";
import { readBooleanConfig, readPositiveIntegerConfig } from "../libs/config.js";
import { debugLog, formatError } from "../libs/debug.js";
import {
	addAttachmentImageUrl,
	addEmbedImageUrls,
	addLikelyImageUrl,
} from "../libs/imageUrls.js";

const DEFAULT_OCR_START_DELAY_SECONDS = 5;
const ocrStartDelayMs =
	readPositiveIntegerConfig(
		"OCR_START_DELAY_SECONDS",
		DEFAULT_OCR_START_DELAY_SECONDS,
	) * 1000;
const ocrCheckEmojis = readBooleanConfig("OCR_CHECK_EMOJIS", false);
const ocrCheckStickers = readBooleanConfig("OCR_CHECK_STICKERS", true);
const applyToModerators = readBooleanConfig("APPLY_TO_MODERATORS", true);

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleMessage(message: Message) {
	const isModerator =
		message.member?.permissions.has(
			PermissionsBitField.Flags.ManageGuild,
			true,
		) ?? false;
	const skipReason = message.author.bot
		? "author_is_bot"
		: !message.inGuild()
			? "not_in_guild"
			: !applyToModerators && isModerator
				? "moderator_exempt"
				: null;

	if (skipReason) {
		debugLog("message skipped", {
			reason: skipReason,
			author: message.author.tag,
			guild: message.guild?.name ?? null,
			attachments: message.attachments.size,
			embeds: message.embeds.length,
			stickers: message.stickers.size,
			contentLength: message.content.length,
		});
		return;
	}

	debugLog("message received", {
		author: message.author.tag,
		guild: message.guild?.name ?? null,
		channelId: message.channelId,
		attachments: message.attachments.size,
		embeds: message.embeds.length,
		stickers: message.stickers.size,
		contentLength: message.content.length,
	});

	const imagesToCheck = new Set<string>();
	for (const embed of message.embeds) {
		addEmbedImageUrls(imagesToCheck, embed);
	}
	message.attachments.forEach((attachment) => {
		addAttachmentImageUrl(imagesToCheck, attachment);
	});
	if (ocrCheckStickers) {
		message.stickers.forEach((sticker) => {
			addLikelyImageUrl(imagesToCheck, sticker.url);
		});
	}
	if (ocrCheckEmojis && message.content) {
		/<:.+?:[0-9]+?>/g.exec(message.content)?.forEach((emojiDeclaration) => {
			const emojiId = /:[0-9].+[0-9]>/
				.exec(emojiDeclaration)
				?.at(0)
				?.slice(1)
				.slice(0, -1)
				.toString();
			if (emojiId) {
				addLikelyImageUrl(
					imagesToCheck,
					`https://cdn.discordapp.com/emojis/${emojiId}.webp?size=max&quality=lossless`,
				);
			}
		});
	}

	const newImagesToCheck = Array.from(imagesToCheck).filter((image) =>
		claimOcrImage(message, image),
	);

	debugLog("images to check", {
		messageId: message.id,
		totalImages: imagesToCheck.size,
		newImages: newImagesToCheck.length,
		images: Array.from(imagesToCheck),
	});

	if (imagesToCheck.size === 0) {
		debugLog("message has no checkable images");
		return;
	}
	if (newImagesToCheck.length === 0) {
		debugLog("OCR skipped", {
			reason: "images_already_claimed",
			messageId: message.id,
		});
		return;
	}

	debugLog("delaying OCR start", {
		messageId: message.id,
		delayMs: ocrStartDelayMs,
	});
	await delay(ocrStartDelayMs);

	for (const image of newImagesToCheck) {
		try {
			debugLog("processing image", { image });
			const matchedAutoModRule = await processer(message.member!, message, image);
			if (matchedAutoModRule) {
				debugLog("remaining OCR skipped", {
					reason: "automod_match_already_handled",
					messageId: message.id,
				});
				return;
			}
		} catch (error) {
			debugLog("processing image failed", {
				image,
				error: formatError(error),
			});
			console.error(error);
		}
	}
}
