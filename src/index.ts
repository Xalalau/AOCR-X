import {
	Client,
	Events,
	GatewayIntentBits,
	type Message,
	Partials,
} from "discord.js";
import { handleMessage } from "./handlers/message.js";
import { handleReaction } from "./handlers/reaction.js";
import { readBooleanConfig } from "./libs/config.js";
import { debugLog } from "./libs/debug.js";
import { hasEmbedImageUrl, isImageAttachment } from "./libs/imageUrls.js";
import { shutdownOcr } from "./libs/ocr.js";

const ocrCheckEmojis = readBooleanConfig("OCR_CHECK_EMOJIS", false);
const ocrCheckReactions = readBooleanConfig("OCR_CHECK_REACTIONS", true);
const ocrCheckStickers = readBooleanConfig("OCR_CHECK_STICKERS", true);

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

function messageHasCheckableContent(message: Message) {
	return Boolean(
		message.attachments.some((attachment) => isImageAttachment(attachment)) ||
			message.embeds.some((embed) => hasEmbedImageUrl(embed)) ||
			(ocrCheckStickers && message.stickers.at(0)) ||
			(ocrCheckEmojis && message.content),
	);
}

client.once(Events.ClientReady, () => {
	console.log("Connected to Discord!");
	debugLog("client ready", {
		user: client.user?.tag ?? null,
		guilds: client.guilds.cache.size,
		processId: process.pid,
	});
});

client.on(Events.MessageCreate, (message) => {
	const shouldCheck = messageHasCheckableContent(message);
	debugLog("message create event", {
		author: message.author.tag,
		guild: message.guild?.name ?? null,
		channelId: message.channelId,
		attachments: message.attachments.size,
		embeds: message.embeds.length,
		stickers: message.stickers.size,
		contentLength: message.content.length,
		shouldCheck,
	});

	if (shouldCheck) {
		try {
			void handleMessage(message);
		} catch (error) {
			console.error(error);
		}
	}
});

client.on(Events.MessageUpdate, (_oldMessage, newMessage) => {
	const message = newMessage as Message;
	const shouldCheck = messageHasCheckableContent(message);
	debugLog("message update event", {
		guild: message.guild?.name ?? null,
		channelId: message.channelId,
		attachments: message.attachments.size,
		embeds: message.embeds.length,
		stickers: message.stickers.size,
		shouldCheck,
	});

	if (shouldCheck) {
		try {
			void handleMessage(message);
		} catch (error) {
			console.error(error);
		}
	}
});

if (ocrCheckReactions) {
	client.on(Events.MessageReactionAdd, (reaction) => {
		void reaction.fetch().then(() => {
			if (reaction.count !== 1) {
				debugLog("reaction skipped before handler", {
					reason: "reaction_count_not_1",
					count: reaction.count,
				});
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

client.on(Events.Invalidated, async () => {
	console.log("Session Invalidated - Stopping Client");
	await client.destroy();
	await shutdownOcr();
	process.exit(1);
});

await client.login(process.env.DISCORD_TOKEN);
