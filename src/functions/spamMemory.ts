import { EmbedBuilder, type Client, type Message } from "discord.js";
import {
	readBooleanConfig,
	readIntegerConfig,
	readNonNegativeIntegerConfig,
	readPositiveIntegerConfig,
} from "../libs/config.js";
import {
	debugLog,
	formatError,
	isAocrDebugEnabled,
	normalizeWhitespace,
} from "../libs/debug.js";
import { isDiscordUnknownMessageError } from "../libs/discordErrors.js";
import {
	banRecurrentSpamMember,
	formatRecurrentSpamSummary,
	registerRecurrentSpamWave,
	type RecurrentSpamDecision,
} from "./recurrentSpam.js";

const DEFAULT_TEXT_SPAM_MEMORY_SIZE = 250;
const DEFAULT_TEXT_SPAM_MEMORY_TIMEOUT = 60;
const DEFAULT_TEXT_SPAM_DELAY_SECONDS = 3;
const DEFAULT_TEXT_SPAM_SILENCE_TIMEOUT = 60;
const DEFAULT_TEXT_SPAM_DUPLICATE_THRESHOLD = 3;
const MIN_TEXT_SPAM_DUPLICATE_THRESHOLD = 2;
const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;

const textSpamMemorySize = readPositiveIntegerConfig(
	"TEXT_SPAM_MEMORY_SIZE",
	DEFAULT_TEXT_SPAM_MEMORY_SIZE,
);
const textSpamMemoryTimeoutMs =
	readPositiveIntegerConfig(
		"TEXT_SPAM_MEMORY_TIMEOUT",
		DEFAULT_TEXT_SPAM_MEMORY_TIMEOUT,
	) * 1000;
const textSpamDelayMs =
	readNonNegativeIntegerConfig(
		"TEXT_SPAM_DELAY_SECONDS",
		DEFAULT_TEXT_SPAM_DELAY_SECONDS,
	) * 1000;
const textSpamSilenceUser = readBooleanConfig("TEXT_SPAM_SILENCE_USER", true);
const textSpamSilenceTimeoutMs =
	readNonNegativeIntegerConfig(
		"TEXT_SPAM_SILENCE_TIMEOUT",
		DEFAULT_TEXT_SPAM_SILENCE_TIMEOUT,
	) * 1000;
const textSpamBanUser = readBooleanConfig("TEXT_SPAM_BAN_USER", false);
const textSpamDuplicateThreshold = readIntegerConfig(
	"TEXT_SPAM_DUPLICATE_THRESHOLD",
	DEFAULT_TEXT_SPAM_DUPLICATE_THRESHOLD,
	MIN_TEXT_SPAM_DUPLICATE_THRESHOLD,
);
const textSpamCrossUserMatching = readBooleanConfig(
	"TEXT_SPAM_CROSS_USER_MATCHING",
	false,
);
const sendDetectionDmEnabled = readBooleanConfig("SEND_DETECTION_DM", false);

type TextSpamAlertChannelConfig = {
	fallbackChannelId: string | null;
	channelIdsByGuildId: Map<string, string>;
};

function getConfigEntrySeparatorIndex(entry: string) {
	const colonIndex = entry.indexOf(":");
	const equalsIndex = entry.indexOf("=");

	if (colonIndex === -1) {
		return equalsIndex;
	}
	if (equalsIndex === -1) {
		return colonIndex;
	}

	return Math.min(colonIndex, equalsIndex);
}

function readTextSpamAlertChannelConfig(): TextSpamAlertChannelConfig {
	const rawValue = process.env.TEXT_SPAM_ALERT_CHANNEL_ID?.trim();
	const channelIdsByGuildId = new Map<string, string>();

	if (!rawValue) {
		return {
			fallbackChannelId: null,
			channelIdsByGuildId,
		};
	}

	let fallbackChannelId: string | null = null;

	for (const rawEntry of rawValue.split(/[,;\n]/)) {
		const entry = rawEntry.trim();
		if (!entry) {
			continue;
		}

		const separatorIndex = getConfigEntrySeparatorIndex(entry);
		if (separatorIndex === -1) {
			fallbackChannelId = entry;
			continue;
		}

		const guildId = entry.slice(0, separatorIndex).trim();
		const channelId = entry.slice(separatorIndex + 1).trim();
		if (!guildId || !channelId) {
			continue;
		}

		if (guildId === "*" || guildId.toLowerCase() === "default") {
			fallbackChannelId = channelId;
			continue;
		}

		channelIdsByGuildId.set(guildId, channelId);
	}

	return {
		fallbackChannelId,
		channelIdsByGuildId,
	};
}

const textSpamAlertChannelConfig = readTextSpamAlertChannelConfig();

type SpamMemoryEntry = {
	id: string;
	authorId: string;
	channelId: string;
	guildId: string;
	signature: string;
	deletedDueToSpam: boolean;
	createdTimestamp: number;
};

const spamMemory: SpamMemoryEntry[] = [];
const pendingSpamWaveKeys = new Set<string>();

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTextMessageSignature(message: Message) {
	const content = normalizeWhitespace(message.content).toLowerCase();
	return content.length > 0 ? content : null;
}

function getSpamWaveKey(guildId: string, authorId: string, signature: string) {
	const authorKey = textSpamCrossUserMatching ? "*" : authorId;
	return `${guildId}:${authorKey}:${signature}`;
}

function getSpamWaveKeyForEntry(entry: SpamMemoryEntry) {
	return getSpamWaveKey(entry.guildId, entry.authorId, entry.signature);
}

function trimSpamMemory(referenceTimestamp = Date.now()) {
	const oldestTimestamp = referenceTimestamp - textSpamMemoryTimeoutMs;
	for (let index = spamMemory.length - 1; index >= 0; index -= 1) {
		const entry = spamMemory[index];
		if (entry && entry.createdTimestamp < oldestTimestamp) {
			spamMemory.splice(index, 1);
		}
	}

	while (spamMemory.length > textSpamMemorySize) {
		spamMemory.shift();
	}
}

function rememberMessage(message: Message, signature: string) {
	trimSpamMemory(message.createdTimestamp);

	const existingEntry = spamMemory.find((entry) => entry.id === message.id);
	if (existingEntry) {
		existingEntry.signature = signature;
		existingEntry.deletedDueToSpam = false;
		return existingEntry;
	}

	const entry: SpamMemoryEntry = {
		id: message.id,
		authorId: message.author.id,
		channelId: message.channelId,
		guildId: message.guildId!,
		signature,
		deletedDueToSpam: false,
		createdTimestamp: message.createdTimestamp,
	};

	spamMemory.push(entry);
	trimSpamMemory(message.createdTimestamp);
	return entry;
}

function getDuplicateEntries(
	entry: SpamMemoryEntry,
	referenceTimestamp = entry.createdTimestamp,
) {
	const oldestTimestamp = referenceTimestamp - textSpamMemoryTimeoutMs;
	return spamMemory.filter(
		(candidate) =>
			!candidate.deletedDueToSpam &&
			candidate.createdTimestamp >= oldestTimestamp &&
			candidate.guildId === entry.guildId &&
			(textSpamCrossUserMatching || candidate.authorId === entry.authorId) &&
			candidate.signature === entry.signature,
	);
}

function truncateText(text: string, maxLength: number) {
	if (text.length <= maxLength) {
		return text;
	}

	return `${text.slice(0, maxLength - 3)}...`;
}

function truncateEmbedField(value: string) {
	return truncateText(value, MAX_EMBED_FIELD_VALUE_LENGTH);
}

function getPunishmentDescription(recurrentDecision?: RecurrentSpamDecision) {
	if (recurrentDecision?.shouldBan) {
		return "recurrent ban";
	}
	if (textSpamBanUser) {
		return "ban";
	}
	if (!textSpamSilenceUser || textSpamSilenceTimeoutMs === 0) {
		return "delete only";
	}

	return `silence ${Math.floor(textSpamSilenceTimeoutMs / 1000).toString()}s`;
}

function formatSpamMessages(entries: SpamMemoryEntry[]) {
	return truncateEmbedField(
		entries
			.map(
				(entry) =>
					`- ${entry.id} in <#${entry.channelId}> at ${new Date(
						entry.createdTimestamp,
					).toISOString()}`,
			)
			.join("\n"),
	);
}

function formatSpamSummary(
	message: Message,
	entries: SpamMemoryEntry[],
	recurrentDecision: RecurrentSpamDecision,
) {
	return truncateEmbedField(
		[
			`Guild: ${message.guild?.name ?? message.guildId}`,
			`Messages: ${entries.length.toString()}`,
			`Action: ${getPunishmentDescription(recurrentDecision)}`,
		].join("\n"),
	);
}

function formatMinimalSpamDetection(sample: string) {
	return truncateEmbedField(
		[
			"Rule: Repeated text spam",
			`Detected: ${sample.length > 0 ? sample : "(repeated text)"}`,
		].join("\n"),
	);
}

async function getMessageMember(message: Message) {
	try {
		return message.member ?? (await message.guild?.members.fetch(message.author.id));
	} catch (error) {
		debugLog("repeated text spam member fetch failed", formatError(error));
		return null;
	}
}

async function banMemberForTextSpam(message: Message) {
	const member = await getMessageMember(message);
	if (!member) {
		debugLog("repeated text spam ban skipped", {
			reason: "member_not_found",
			author: message.author.tag,
		});
		return;
	}
	if (!member.bannable) {
		debugLog("repeated text spam ban skipped", {
			reason: "member_not_bannable",
			author: message.author.tag,
		});
		return;
	}

	try {
		await member.ban({
			reason: "AOCR-X: repeated text spam",
			deleteMessageSeconds: 0,
		});
		debugLog("repeated text spam ban applied", {
			author: message.author.tag,
		});
	} catch (error) {
		debugLog("repeated text spam ban failed", formatError(error));
	}
}

async function banSpamAuthor(message: Message) {
	if (!textSpamBanUser) {
		debugLog("repeated text spam ban skipped", {
			reason: "ban_disabled",
			author: message.author.tag,
		});
		return;
	}

	await banMemberForTextSpam(message);
}

async function banRecurrentSpamAuthor(message: Message) {
	const member = await getMessageMember(message);
	if (!member) {
		debugLog("recurrent spam ban skipped", {
			reason: "member_not_found",
			author: message.author.tag,
		});
		return;
	}

	await banRecurrentSpamMember(member, "AOCR-X: recurrent repeated text spam");
}

async function silenceSpamAuthor(message: Message) {
	if (textSpamBanUser) {
		debugLog("repeated text spam silence skipped", {
			reason: "ban_enabled",
			author: message.author.tag,
		});
		return;
	}
	if (!textSpamSilenceUser) {
		debugLog("repeated text spam silence skipped", {
			reason: "silence_disabled",
			author: message.author.tag,
		});
		return;
	}
	if (textSpamSilenceTimeoutMs === 0) {
		debugLog("repeated text spam silence skipped", {
			reason: "silence_timeout_disabled",
			author: message.author.tag,
		});
		return;
	}

	const member = await getMessageMember(message);
	if (!member) {
		debugLog("repeated text spam silence skipped", {
			reason: "member_not_found",
			author: message.author.tag,
		});
		return;
	}
	if (!member.moderatable) {
		debugLog("repeated text spam silence skipped", {
			reason: "member_not_moderatable",
			author: message.author.tag,
		});
		return;
	}

	try {
		await member.timeout(textSpamSilenceTimeoutMs, "AOCR-X: repeated text spam");
		debugLog("repeated text spam silence applied", {
			author: message.author.tag,
			durationMs: textSpamSilenceTimeoutMs,
		});
	} catch (error) {
		debugLog("repeated text spam silence failed", formatError(error));
	}
}

async function punishSpamAuthor(
	message: Message,
	recurrentDecision: RecurrentSpamDecision,
) {
	if (recurrentDecision.shouldBan) {
		await banRecurrentSpamAuthor(message);
		return;
	}

	if (textSpamBanUser) {
		await banSpamAuthor(message);
		return;
	}

	await silenceSpamAuthor(message);
}

async function deleteSpamMessages(entries: SpamMemoryEntry[], client: Client) {
	await Promise.all(
		entries.map(async (entry) => {
			try {
				const channel = await client.channels.fetch(entry.channelId);
				if (!channel?.isTextBased()) {
					debugLog("repeated text spam channel not text based", {
						messageId: entry.id,
						channelId: entry.channelId,
					});
					return;
				}

				await channel.messages.delete(entry.id);
				debugLog("repeated text spam message deleted", {
					messageId: entry.id,
					channelId: entry.channelId,
				});
			} catch (error) {
				if (isDiscordUnknownMessageError(error)) {
					debugLog("repeated text spam message already deleted", {
						messageId: entry.id,
						channelId: entry.channelId,
					});
					return;
				}

				debugLog("repeated text spam delete failed", {
					messageId: entry.id,
					error: formatError(error),
				});
			}
		}),
	);
}

async function sendDetectionDm(message: Message) {
	if (!sendDetectionDmEnabled) {
		debugLog("repeated text spam member DM skipped", {
			reason: "dm_disabled",
			author: message.author.tag,
		});
		return;
	}

	try {
		await message.author.send("AOCR-X: repeated text spam detected");
		debugLog("repeated text spam member DM sent", {
			author: message.author.tag,
		});
	} catch (error) {
		debugLog("repeated text spam member DM failed", formatError(error));
	}
}

function hasTextSpamAlertChannelConfig() {
	return (
		textSpamAlertChannelConfig.fallbackChannelId !== null ||
		textSpamAlertChannelConfig.channelIdsByGuildId.size > 0
	);
}

function getTextSpamAlertChannelId(message: Message) {
	if (!message.guildId) {
		return textSpamAlertChannelConfig.fallbackChannelId;
	}

	return (
		textSpamAlertChannelConfig.channelIdsByGuildId.get(message.guildId) ??
		textSpamAlertChannelConfig.fallbackChannelId
	);
}

async function sendSpamAlert(
	message: Message,
	entries: SpamMemoryEntry[],
	recurrentDecision: RecurrentSpamDecision,
) {
	const textSpamAlertChannelId = getTextSpamAlertChannelId(message);
	if (!textSpamAlertChannelId) {
		debugLog("repeated text spam alert skipped", {
			reason: hasTextSpamAlertChannelConfig()
				? "alert_channel_not_configured_for_guild"
				: "alert_channel_not_configured",
			guildId: message.guildId,
		});
		return;
	}

	try {
		const channel = await message.client.channels.fetch(textSpamAlertChannelId);
		if (!channel?.isSendable()) {
			debugLog("repeated text spam alert skipped", {
				reason: "alert_channel_not_sendable",
				channelId: textSpamAlertChannelId,
			});
			return;
		}

		const sample = truncateText(entries.at(0)?.signature ?? "", 900);
		const embed = new EmbedBuilder().setAuthor({
			name: message.author.username,
			iconURL: message.author.displayAvatarURL(),
		});

		if (isAocrDebugEnabled()) {
			embed
				.addFields({
					name: "User:",
					value: `<@${message.author.id}>`,
				})
				.addFields({
					name: "AOCR-X Text Spam:",
					value: formatSpamSummary(message, entries, recurrentDecision),
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
					name: "Deleted messages:",
					value: formatSpamMessages(entries),
				})
				.addFields({
					name: "Sample:",
					value: `\`\`\`\n${sample}\n\`\`\``,
				});
		} else {
			embed.addFields({
				name: "AOCR-X Detected:",
				value: formatMinimalSpamDetection(sample),
			});
		}

		await channel.send({
			embeds: [embed],
			allowedMentions: { users: [] },
		});
		debugLog("repeated text spam alert sent", {
			channelId: textSpamAlertChannelId,
			messageIds: entries.map((entry) => entry.id),
			recurrentDecision,
		});
	} catch (error) {
		debugLog("repeated text spam alert failed", formatError(error));
	}
}

export function wasDeletedDueToSpam(message: Message) {
	trimSpamMemory();

	const entry = spamMemory.find((candidate) => candidate.id === message.id);
	if (!entry) {
		return false;
	}

	return (
		entry.deletedDueToSpam || pendingSpamWaveKeys.has(getSpamWaveKeyForEntry(entry))
	);
}

export async function detectDuplicateSpam(message: Message) {
	trimSpamMemory(message.createdTimestamp);

	const signature = getTextMessageSignature(message);
	if (!signature) {
		debugLog("repeated text spam memory skipped", {
			reason: "empty_text",
			messageId: message.id,
			author: message.author.tag,
		});
		return false;
	}

	const entry = rememberMessage(message, signature);
	const duplicateEntries = getDuplicateEntries(entry);

	debugLog("repeated text spam memory updated", {
		messageId: message.id,
		author: message.author.tag,
		memorySize: spamMemory.length,
		maxMemorySize: textSpamMemorySize,
		memoryTimeoutMs: textSpamMemoryTimeoutMs,
		duplicateCount: duplicateEntries.length,
		duplicateThreshold: textSpamDuplicateThreshold,
	});

	if (duplicateEntries.length < textSpamDuplicateThreshold) {
		return false;
	}

	const spamWaveKey = getSpamWaveKeyForEntry(entry);
	if (pendingSpamWaveKeys.has(spamWaveKey)) {
		debugLog("repeated text spam wave already scheduled", {
			author: message.author.tag,
			messageId: message.id,
			delayMs: textSpamDelayMs,
		});
		return true;
	}

	pendingSpamWaveKeys.add(spamWaveKey);
	try {
		debugLog("repeated text spam wave scheduled", {
			author: message.author.tag,
			messageIds: duplicateEntries.map((duplicateEntry) => duplicateEntry.id),
			delayMs: textSpamDelayMs,
		});

		if (textSpamDelayMs > 0) {
			await delay(textSpamDelayMs);
		}

		trimSpamMemory();
		const entriesToProcess = getDuplicateEntries(entry, Date.now());
		if (entriesToProcess.length < textSpamDuplicateThreshold) {
			debugLog("repeated text spam wave skipped", {
				reason: "not_enough_entries_after_delay",
				author: message.author.tag,
				duplicateCount: entriesToProcess.length,
				duplicateThreshold: textSpamDuplicateThreshold,
			});
			return false;
		}

		for (const duplicateEntry of entriesToProcess) {
			duplicateEntry.deletedDueToSpam = true;
		}

		const recurrentDecision = await registerRecurrentSpamWave({
			guildId: message.guildId!,
			authorId: message.author.id,
			authorTag: message.author.tag,
			source: "text_spam",
		});

		debugLog("repeated text spam detected", {
			author: message.author.tag,
			messageIds: entriesToProcess.map((duplicateEntry) => duplicateEntry.id),
			delayMs: textSpamDelayMs,
			recurrentDecision,
		});

		await Promise.all([
			punishSpamAuthor(message, recurrentDecision),
			deleteSpamMessages(entriesToProcess, message.client),
			sendDetectionDm(message),
			sendSpamAlert(message, entriesToProcess, recurrentDecision),
		]);

		return true;
	} finally {
		pendingSpamWaveKeys.delete(spamWaveKey);
	}
}
