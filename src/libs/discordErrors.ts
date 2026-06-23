const DISCORD_UNKNOWN_MESSAGE_ERROR_CODE = 10008;

export function isDiscordUnknownMessageError(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === DISCORD_UNKNOWN_MESSAGE_ERROR_CODE
	);
}
