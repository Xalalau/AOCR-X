import {
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	Partials,
} from "discord.js";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.AutoModerationConfiguration,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMessageReactions,
	],
	partials: [Partials.Reaction, Partials.Message], // We need these partials to get messages and reactions sent before the bot started
});

client.once(Events.ClientReady, () => {
	console.log("Connected to Discord!");
});

import { handleMessage } from "./handlers/message.js";

client.on(Events.MessageCreate, (message) => {
	if (
		message.attachments.at(0) ??
		message.embeds.at(0) ??
		(message.stickers.at(0) && process.env.CHECK_STICKERS === "true") ??
		process.env.CHECK_EMOJIS === "true"
	) {
		try {
			void handleMessage(message);
		} catch (error) {
			console.error(error);
		}
	}
});

client.on(Events.MessageUpdate, (message) => {
	if (
		message.attachments.at(0) ??
		message.embeds.at(0) ??
		message.stickers.size !== 0
	) {
		try {
			void handleMessage(message as Message);
		} catch (error) {
			console.error(error);
		}
	}
});

if (process.env.CHECK_REACTIONS === "true") {
	client.on(Events.MessageReactionAdd, (reaction) => {
		void reaction.fetch().then(() => {
			if (reaction.count !== 1) {
				return;
			}
			try {
				void handleReaction(reaction);
			} catch (error) {
				console.error(error);
			}
		});
	});
}

client.on(Events.Error, (error) => {
	console.error(error);
});
client.on(Events.Warn, (warning) => {
	console.warn(warning);
});

import { handleReaction } from "./handlers/reaction.js";
import { ocr } from "./libs/tesseract.js";

client.on(Events.Invalidated, () => {
	async () => {
		console.log("Session Invalidated - Stopping Client");
		await client.destroy();
		await ocr.terminate();
		process.exit(1);
	};
});

await client.login(process.env.DISCORD_TOKEN);
