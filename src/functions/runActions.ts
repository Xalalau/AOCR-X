import {
	type AutoModerationAction,
	AutoModerationActionType,
	EmbedBuilder,
	type GuildMember,
	Message,
	type TextChannel,
} from "discord.js";
import { readBooleanConfig } from "../libs/config.js";
import {
	debugLog,
	formatError,
	isAocrDebugEnabled,
	normalizeWhitespace,
} from "../libs/debug.js";
import { isDiscordUnknownMessageError } from "../libs/discordErrors.js";
import type { OcrResult } from "../types/OcrResult.js";
import type { MessageReactionExtended } from "../types/Extensions.js";
import {
	banRecurrentSpamMember,
	formatRecurrentSpamSummary,
	registerRecurrentSpamWave,
} from "./recurrentSpam.js";

const DEFAULT_BLOCK_MESSAGE = "AOCR-X: Rule Broken";
const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;
const sendDetectionDmEnabled = readBooleanConfig("SEND_DETECTION_DM", false);

export type OcrRuleMatch = {
	ruleName: string;
	type: "keyword" | "regex";
	pattern: string;
	matches: string[];
};

function truncateEmbedField(value: string) {
	if (value.length <= MAX_EMBED_FIELD_VALUE_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_EMBED_FIELD_VALUE_LENGTH - 3)}...`;
}

function formatMatch(match: OcrRuleMatch) {
	return truncateEmbedField(
		[
			`Rule: ${match.ruleName}`,
			`Type: ${match.type}`,
			`Pattern: ${match.pattern}`,
			`Detected: ${match.matches.length > 0 ? match.matches.join(", ") : "(match found)"}`,
		].join("\n"),
	);
}

function formatMinimalMatch(match: OcrRuleMatch) {
	return truncateEmbedField(
		[
			`Rule: ${match.ruleName}`,
			`Detected: ${match.matches.length > 0 ? match.matches.join(", ") : "(match found)"}`,
		].join("\n"),
	);
}

export async function runActions(
	member: GuildMember,
	automodActions: AutoModerationAction[],
	event: Message | MessageReactionExtended,
	ocrData: OcrResult,
	imageUrl: string,
	match: OcrRuleMatch,
) {
	const recurrentDecision = await registerRecurrentSpamWave({
		guildId: member.guild.id,
		authorId: member.id,
		authorTag: member.user.tag,
		source: "ocr",
	});

	debugLog("running AutoMod actions", {
		member: member.user.tag,
		memberId: member.id,
		processId: process.pid,
		actions: automodActions.map((action) => ({
			type: action.type,
			metadata: action.metadata,
		})),
		match,
		recurrentDecision,
		recognizedText: normalizeWhitespace(ocrData.text),
		confidence: ocrData.confidence,
	});

	const blockRule = automodActions.find(
		(rule) => rule.type === AutoModerationActionType.BlockMessage,
	);
	const alertRule = automodActions.find(
		(rule) => rule.type === AutoModerationActionType.SendAlertMessage,
	);
	const timeoutRule = automodActions.find(
		(rule) => rule.type === AutoModerationActionType.Timeout,
	);
	const blockMessage =
		blockRule?.metadata.customMessage && blockRule.metadata.customMessage.length > 0
			? blockRule.metadata.customMessage
			: DEFAULT_BLOCK_MESSAGE;

	const embed = new EmbedBuilder().setAuthor({
		name: member.user.username,
		iconURL: member.user.displayAvatarURL(),
	});

	if (isAocrDebugEnabled()) {
		embed
			.addFields({
				name: "User:",
				value: `<@${member.id}>`,
			})
			.addFields({
				name: "AOCR-X Recognized:",
				value: ocrData.text.replaceAll("\n", ""),
			})
			.addFields({
				name: "AOCR-X Detected:",
				value: formatMatch(match),
			});

		const recurrentSummary = formatRecurrentSpamSummary(recurrentDecision);
		if (recurrentSummary) {
			embed.addFields({
				name: "AOCR-X Recurrent Spam:",
				value: recurrentSummary,
			});
		}

		embed
			.addFields({
				name: "Result Confidence:",
				value: `${ocrData.confidence.toString()}%`,
			})
			.setImage(imageUrl);
	} else {
		embed.addFields({
			name: "AOCR-X Detected:",
			value: formatMinimalMatch(match),
		});
	}

	if (timeoutRule) {
		if (recurrentDecision.shouldBan) {
			debugLog("timeout skipped", {
				reason: "recurrent_ban",
				member: member.user.tag,
			});
		} else if (member.moderatable) {
			try {
				await member.timeout(
					timeoutRule.metadata.durationSeconds! * 1000,
					timeoutRule.metadata.customMessage
						? timeoutRule.metadata.customMessage
						: "AOCR-X: Rule Broken",
				);
				debugLog("timeout applied", {
					member: member.user.tag,
					durationSeconds: timeoutRule.metadata.durationSeconds,
				});
			} catch (error) {
				debugLog("timeout failed", formatError(error));
			}
		} else {
			debugLog("timeout skipped", {
				member: member.user.tag,
				moderatable: member.moderatable,
			});
		}
	}

	if (alertRule) {
		try {
			const channel = event.client.channels.cache.get(
				alertRule.metadata.channelId!,
			) as TextChannel | undefined;
			if (!channel) {
				debugLog("alert channel not found", {
					channelId: alertRule.metadata.channelId,
				});
			} else {
				await channel.send({
					embeds: [embed],
				});
				debugLog("alert sent", {
					channelId: alertRule.metadata.channelId,
				});
			}
		} catch (error) {
			debugLog("alert failed", formatError(error));
		}
	}

	if (blockRule) {
		if (sendDetectionDmEnabled) {
			try {
				await member.send({
					content: blockMessage,
					embeds: [embed],
				});
				debugLog("member DM sent", { member: member.user.tag });
			} catch (error) {
				debugLog("member DM failed", formatError(error));
			}
		} else {
			debugLog("member DM skipped", { member: member.user.tag });
		}

		try {
			if (event instanceof Message) {
				debugLog("block message action", {
					deletable: event.deletable,
					messageId: event.id,
					channelId: event.channelId,
				});
				if (event.deletable) {
					await event.delete();
					debugLog("message deleted", { messageId: event.id });
				} else {
					debugLog("message not deletable", { messageId: event.id });
				}
			} else {
				await event.remove();
				debugLog("reaction removed");
			}
		} catch (error) {
			if (isDiscordUnknownMessageError(error)) {
				debugLog("block action skipped", {
					reason: "message_already_deleted",
					eventId: event instanceof Message ? event.id : event.message.id,
					channelId: event.channelId,
				});
			} else {
				debugLog("block action failed", formatError(error));
			}
		}
	}

	if (recurrentDecision.shouldBan) {
		await banRecurrentSpamMember(member, "AOCR-X: recurrent OCR spam");
	}
}
