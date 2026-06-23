import type { Message } from "discord.js";

const MAX_OCR_MEMORY_ENTRIES = 1000;

const processedOcrKeys = new Set<string>();
const processedOcrKeyQueue: string[] = [];

function getOcrKey(message: Message, imageUrl: string) {
	return `${message.id}:${imageUrl}`;
}

function trimOcrMemory() {
	while (processedOcrKeyQueue.length > MAX_OCR_MEMORY_ENTRIES) {
		const oldestKey = processedOcrKeyQueue.shift();
		if (oldestKey) {
			processedOcrKeys.delete(oldestKey);
		}
	}
}

export function claimOcrImage(message: Message, imageUrl: string) {
	const key = getOcrKey(message, imageUrl);
	if (processedOcrKeys.has(key)) {
		return false;
	}

	processedOcrKeys.add(key);
	processedOcrKeyQueue.push(key);
	trimOcrMemory();
	return true;
}
