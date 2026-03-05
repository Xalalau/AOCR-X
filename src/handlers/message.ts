import { type Message, PermissionsBitField } from "discord.js";
import { processer } from "../functions/process.js";

export async function handleMessage(message: Message) {
	if (
		message.author.bot ||
		!message.inGuild() ||
		(process.env.APPLY_TO_MODERATORS === "false" &&
			message.member?.permissions.has(
				PermissionsBitField.Flags.ManageGuild,
				true,
			))
	) {
		return;
	}
	const imagesToCheck: string[] = [];
	for (const embed of message.embeds) {
		if (embed.url) {
			imagesToCheck.push(embed.url);
		}
	}
	message.attachments.forEach((attachment) => {
		imagesToCheck.push(attachment.url);
	});
	if (process.env.CHECK_STICKERS === "true") {
		message.stickers.forEach((sticker) => {
			imagesToCheck.push(sticker.url);
		});
	}
	if (process.env.CHECK_EMOJIS === "true" && message.content) {
		/<:.+?:[0-9]+?>/g.exec(message.content)?.forEach((emojiDeclaration) => {
			const emojiId = /:[0-9].+[0-9]>/
				.exec(emojiDeclaration)
				?.at(0)
				?.slice(1)
				.slice(0, -1)
				.toString();
			if (emojiId) {
				imagesToCheck.push(
					`https://cdn.discordapp.com/emojis/${emojiId}.webp?size=max&quality=lossless`,
				);
			}
		});
	}

	for (const image of imagesToCheck) {
		try {
			await processer(message.member!, message, image);
		} catch (e) {
			console.error(e);
		}
	}
}
