import { readBooleanConfig } from "./config.js";

export function debugLog(message: string, data?: unknown) {
	if (!isAocrDebugEnabled()) {
		return;
	}

	if (data === undefined) {
		console.log(`[AOCR-X] ${message}`);
		return;
	}

	console.log(`[AOCR-X] ${message}`, data);
}

export function normalizeWhitespace(text: string) {
	return text.replace(/\s+/g, " ").trim();
}

export function isAocrDebugEnabled() {
	return readBooleanConfig("DEBUG_AOCR", true);
}

export function formatError(error: unknown) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}

	return error;
}
