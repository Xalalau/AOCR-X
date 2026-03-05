import type { MessageReaction } from "discord.js";
import { processer } from "../functions/process.js";
import type { MessageReactionExtended } from "../types/Extensions.js";

export async function handleReaction(reaction: MessageReaction) {
	if (reaction.message.partial) {
		reaction.message = await reaction.message.fetch();
	}
	let user = reaction.users.cache.at(0);
	if (!user) {
		user = (await reaction.users.fetch()).at(0);
	}
	if (
		!user ||
		user.bot ||
		!reaction.message.inGuild() ||
		reaction.emoji.imageURL() == null
	) {
		return;
	}

	const extendedReaction = reaction as MessageReactionExtended;
	extendedReaction.channelId = reaction.message.channelId;
	extendedReaction.guild = reaction.message.guild;

	await processer(
		await reaction.message.guild.members.fetch(user),
		extendedReaction,
		reaction.emoji.imageURL({ size: 4096 })!,
	);
}
