import {
	AutoModerationRuleTriggerType,
	type GuildMember,
	type Message,
} from "discord.js";
import { ocr } from "../libs/tesseract.js";
import type { MessageReactionExtended } from "../types/Extensions.js";
import { runActions } from "./runActions.js";

export async function processer(
	member: GuildMember, // We require member separately so we can punish a user that is not the message author
	event: Message | MessageReactionExtended,
	imageUrl: string,
) {
	const automodRules = await event.guild?.autoModerationRules.fetch();
	const ocrData = await ocr.addJob("recognize", imageUrl);

	if (!automodRules) {
		return;
	}

	for (let ruleNumber = 0; ruleNumber < automodRules.size; ++ruleNumber) {
		const rule = automodRules.at(ruleNumber)!;

		if (
			rule.triggerType === AutoModerationRuleTriggerType.MentionSpam ||
			rule.triggerType === AutoModerationRuleTriggerType.Spam ||
			!rule.enabled ||
			member.roles.cache.some((role) => rule.exemptRoles.has(role.id)) ||
			rule.exemptChannels.has(event.channelId)
		) {
			continue;
		}

		let cleanedText = ocrData.data.text
			.replaceAll("\n", "")
			.toLowerCase()
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Cut out non ASCII, this is incredibly unreliable
			.replace(/^\x00-\x7F/g, ""); // Tesseract inserts its own newline characters
		rule.triggerMetadata.allowList.forEach((word) => {
			cleanedText = cleanedText.replaceAll(word, "");
		});

		rule.triggerMetadata.keywordFilter.forEach((keyword) => {
			keyword = keyword.replaceAll("*", "");
			if (cleanedText.includes(keyword)) {
				void runActions(member, rule.actions, event, ocrData, imageUrl);
				return;
			}
		});

		rule.triggerMetadata.regexPatterns.forEach((pattern) => {
			if (RegExp(pattern).test(cleanedText)) {
				void runActions(member, rule.actions, event, ocrData, imageUrl);
				return;
			}
		});
	}
}
