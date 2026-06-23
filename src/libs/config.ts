export function readIntegerConfig(
	name: string,
	defaultValue: number,
	minimumValue: number,
) {
	const rawValue = process.env[name];
	if (!rawValue) {
		return defaultValue;
	}

	const parsedValue = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsedValue) || parsedValue < minimumValue) {
		return defaultValue;
	}

	return parsedValue;
}

export function readPositiveIntegerConfig(name: string, defaultValue: number) {
	return readIntegerConfig(name, defaultValue, 1);
}

export function readNonNegativeIntegerConfig(name: string, defaultValue: number) {
	return readIntegerConfig(name, defaultValue, 0);
}

export function readBooleanConfig(name: string, defaultValue: boolean) {
	const rawValue = process.env[name]?.toLowerCase();
	if (!rawValue) {
		return defaultValue;
	}

	if (["1", "true", "yes", "y"].includes(rawValue)) {
		return true;
	}
	if (["0", "false", "no", "n"].includes(rawValue)) {
		return false;
	}

	return defaultValue;
}
