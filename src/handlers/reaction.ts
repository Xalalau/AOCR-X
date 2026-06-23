import { type MessageReaction, PermissionsBitField } from "discord.js";
import { processer } from "../functions/process.js";
import { readBooleanConfig } from "../libs/config.js";
import { debugLog, formatError } from "../libs/debug.js";
import type { MessageReactionExtended } from "../types/Extensions.js";

const applyToModerators = readBooleanConfig("APPLY_TO_MODERATORS", true);

export async function handleReaction(reaction: MessageReaction) {
	debugLog("reaction received", {
		emoji: reaction.emoji.name,
		messageId: reaction.message.id,
		partial: reaction.message.partial,
	});

	if (reaction.message.partial) {
		reaction.message = await reaction.message.fetch();
	}
	let user = reaction.users.cache.at(0);
	if (!user) {
		user = (await reaction.users.fetch()).at(0);
	}
	if (!user) {
		debugLog("reaction skipped", {
			reason: "user_not_found",
			emoji: reaction.emoji.name,
			messageId: reaction.message.id,
		});
		return;
	}
	if (user.bot) {
		debugLog("reaction skipped", {
			reason: "user_is_bot",
			emoji: reaction.emoji.name,
			messageId: reaction.message.id,
		});
		return;
	}
	if (!reaction.message.inGuild()) {
		debugLog("reaction skipped", {
			reason: "not_in_guild",
			emoji: reaction.emoji.name,
			messageId: reaction.message.id,
		});
		return;
	}

	const member = await reaction.message.guild.members.fetch(user);
	const isModerator = member.permissions.has(
		PermissionsBitField.Flags.ManageGuild,
		true,
	);
	if (!applyToModerators && isModerator) {
		debugLog("reaction skipped", {
			reason: "moderator_exempt",
			emoji: reaction.emoji.name,
			messageId: reaction.message.id,
			user: user.tag,
		});
		return;
	}

	const imageUrl = reaction.emoji.imageURL({ size: 4096 });
	if (!imageUrl) {
		debugLog("reaction skipped", {
			reason: "emoji_has_no_image",
			emoji: reaction.emoji.name,
			messageId: reaction.message.id,
		});
		return;
	}

	const extendedReaction = reaction as MessageReactionExtended;
	extendedReaction.channelId = reaction.message.channelId;
	extendedReaction.guild = reaction.message.guild;

	try {
		debugLog("processing reaction image", { imageUrl });
		await processer(member, extendedReaction, imageUrl);
	} catch (error) {
		debugLog("reaction processing failed", formatError(error));
		console.error(error);
	}
}
