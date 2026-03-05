import type { Guild, MessageReaction } from "discord.js";

export interface MessageReactionExtended extends MessageReaction {
	guild?: Guild;
	channelId: string;
}
