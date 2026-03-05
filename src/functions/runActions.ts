import {
	type AutoModerationAction,
	AutoModerationActionType,
	EmbedBuilder,
	type GuildMember,
	Message,
	type MessageReaction,
	type TextChannel,
} from "discord.js";
import type Tesseract from "tesseract.js";

export async function runActions(
	member: GuildMember,
	automodActions: AutoModerationAction[],
	event: Message | MessageReaction,
	ocrData: Tesseract.RecognizeResult,
	imageUrl: string,
) {
	const blockRule = automodActions.find(
		(rule) => rule.type === AutoModerationActionType.BlockMessage,
	);
	const alertRule = automodActions.find(
		(rule) => rule.type === AutoModerationActionType.SendAlertMessage,
	);
	const timeoutRule = automodActions.find(
		(rule) => rule.type === AutoModerationActionType.Timeout,
	);

	const embed = new EmbedBuilder()
		.setAuthor({
			name: member.user.username,
			iconURL: member.user.displayAvatarURL(),
		})
		.addFields({
			name: "User:",
			value: `<@${member.id}>`,
		})
		.addFields({
			name: "AOCR Recognized:",
			value: ocrData.data.text.replaceAll("\n", ""),
		})
		.addFields({
			name: "Result Confidence:",
			value: `${ocrData.data.confidence.toString()}%`,
		})
		.setImage(imageUrl);

	if (timeoutRule) {
		if (member.moderatable && process.env.ONLY_DELETE === "false") {
			try {
				await member.timeout(
					timeoutRule.metadata.durationSeconds! * 1000,
					timeoutRule.metadata.customMessage
						? timeoutRule.metadata.customMessage
						: "AOCR: Rule Broken",
				);
			} catch {
				// Do nothing.
			}
		}
	}

	if (alertRule) {
		try {
			await (
				event.client.channels.cache.get(
					alertRule.metadata.channelId!,
				) as TextChannel
			).send({
				embeds: [embed],
			});
		} catch {
			// Do nothing.
		}
	}

	if (blockRule) {
		try {
			await member.send({
				content: blockRule.metadata.customMessage
					? blockRule.metadata.customMessage
					: "AOCR: Rule Broken",
				embeds: [embed],
			});
		} catch {
			// Do nothing.
		}
		try {
			if (event instanceof Message) {
				console.log(event.deletable);
				if (event.deletable) {
					await event.delete();
				}
			} else {
				await event.remove();
			}
		} catch {
			// Do nothing.
		}
	}
}
