import {
	AutoModerationRuleTriggerType,
	type GuildMember,
	type Message,
} from "discord.js";
import { recognizeImage } from "../libs/ocr.js";
import { debugLog, formatError, normalizeWhitespace } from "../libs/debug.js";
import type { MessageReactionExtended } from "../types/Extensions.js";
import { runActions, type OcrRuleMatch } from "./runActions.js";

function uniqueValues(values: string[]) {
	return Array.from(new Set(values));
}

function getRegexMatches(pattern: string, text: string) {
	const regex = new RegExp(pattern, "gi");
	return uniqueValues(
		Array.from(text.matchAll(regex), (match) => match[0]).filter(Boolean),
	);
}

export async function processer(
	member: GuildMember, // We require member separately so we can punish a user that is not the message author
	event: Message | MessageReactionExtended,
	imageUrl: string,
) {
	debugLog("fetching AutoMod rules", {
		guild: event.guild?.name ?? null,
		guildId: event.guild?.id ?? null,
	});

	const automodRules = await event.guild?.autoModerationRules.fetch();

	debugLog("ocr started", { imageUrl });
	const ocrData = await (async () => {
		try {
			return await recognizeImage(imageUrl);
		} catch (error) {
			debugLog("ocr failed", {
				imageUrl,
				error: formatError(error),
			});
			throw error;
		}
	})();

	if (!automodRules) {
		debugLog("no AutoMod rules returned");
		return false;
	}

	debugLog("ocr result", {
		confidence: ocrData.confidence,
		text: normalizeWhitespace(ocrData.text),
	});

	debugLog(
		"AutoMod rules fetched",
		Array.from(automodRules.values()).map((rule) => ({
			name: rule.name,
			enabled: rule.enabled,
			triggerType: rule.triggerType,
			keywordFilter: rule.triggerMetadata.keywordFilter,
			regexPatterns: rule.triggerMetadata.regexPatterns,
			exemptRoles: Array.from(rule.exemptRoles.keys()),
			exemptChannels: Array.from(rule.exemptChannels.keys()),
		})),
	);

	for (let ruleNumber = 0; ruleNumber < automodRules.size; ++ruleNumber) {
		const rule = automodRules.at(ruleNumber)!;
		const skipReasons: string[] = [];

		if (rule.triggerType === AutoModerationRuleTriggerType.MentionSpam) {
			skipReasons.push("mention_spam_rule");
		}
		if (rule.triggerType === AutoModerationRuleTriggerType.Spam) {
			skipReasons.push("spam_rule");
		}
		if (!rule.enabled) {
			skipReasons.push("rule_disabled");
		}
		if (member.roles.cache.some((role) => rule.exemptRoles.has(role.id))) {
			skipReasons.push("member_role_exempt");
		}
		if (rule.exemptChannels.has(event.channelId)) {
			skipReasons.push("channel_exempt");
		}

		if (skipReasons.length > 0) {
			debugLog("rule skipped", {
				rule: rule.name,
				reasons: skipReasons,
			});
			continue;
		}

		let cleanedText = normalizeWhitespace(
			ocrData.text
				.toLowerCase()
				.replace(/\n/g, " ")
				.replace(/[^\x20-\x7E]/g, " "), // Matches everything NOT between Space (0x20) and Tilde (0x7E)
		);

		rule.triggerMetadata.allowList.forEach((word) => {
			cleanedText = normalizeWhitespace(
				cleanedText.replaceAll(word.toLowerCase(), " "),
			);
		});

		debugLog("checking rule", {
			rule: rule.name,
			cleanedText,
			keywords: rule.triggerMetadata.keywordFilter,
			regex: rule.triggerMetadata.regexPatterns,
		});

		for (const rawKeyword of rule.triggerMetadata.keywordFilter) {
			const keyword = rawKeyword.toLowerCase().replaceAll("*", "");
			if (!keyword) {
				continue;
			}
			if (cleanedText.includes(keyword)) {
				const match: OcrRuleMatch = {
					ruleName: rule.name,
					type: "keyword",
					pattern: rawKeyword,
					matches: [keyword],
				};
				debugLog("keyword matched", {
					rule: rule.name,
					keyword,
					match,
					cleanedText,
				});
				await runActions(member, rule.actions, event, ocrData, imageUrl, match);
				return true;
			}
		}

		for (const pattern of rule.triggerMetadata.regexPatterns) {
			try {
				const matches = getRegexMatches(pattern, cleanedText);
				if (matches.length > 0) {
					const match: OcrRuleMatch = {
						ruleName: rule.name,
						type: "regex",
						pattern,
						matches,
					};
					debugLog("regex matched", {
						rule: rule.name,
						pattern,
						matches,
						cleanedText,
					});
					await runActions(member, rule.actions, event, ocrData, imageUrl, match);
					return true;
				}
			} catch (error) {
				debugLog("regex failed", {
					rule: rule.name,
					pattern,
					error: formatError(error),
				});
			}
		}
	}

	debugLog("no AutoMod match", {
		imageUrl,
		text: normalizeWhitespace(ocrData.text),
	});
	return false;
}
