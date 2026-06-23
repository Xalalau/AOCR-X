import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GuildMember } from "discord.js";
import {
	readBooleanConfig,
	readNonNegativeIntegerConfig,
	readPositiveIntegerConfig,
} from "../libs/config.js";
import { debugLog, formatError } from "../libs/debug.js";

const DEFAULT_SPAM_RECURRENT_GRACE_MINUTES = 2;
const DEFAULT_SPAM_RECURRENT_ALLOWED_WAVES = 2;
const DEFAULT_SPAM_RECURRENT_RESET_DAYS = 7;
const RECURRENT_SPAM_STORAGE_FILE_NAME = "spam-recurrent.json";
const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;
const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const spamRecurrentBanUser = readBooleanConfig("SPAM_RECURRENT_BAN_USER", false);
const spamRecurrentGraceMs =
	readNonNegativeIntegerConfig(
		"SPAM_RECURRENT_GRACE_MINUTES",
		DEFAULT_SPAM_RECURRENT_GRACE_MINUTES,
	) * MILLISECONDS_PER_MINUTE;
const spamRecurrentAllowedWaves = readPositiveIntegerConfig(
	"SPAM_RECURRENT_ALLOWED_WAVES",
	DEFAULT_SPAM_RECURRENT_ALLOWED_WAVES,
);
const spamRecurrentResetMs =
	readPositiveIntegerConfig(
		"SPAM_RECURRENT_RESET_DAYS",
		DEFAULT_SPAM_RECURRENT_RESET_DAYS,
	) * MILLISECONDS_PER_DAY;
const recurrentSpamStoragePath = path.resolve(
	process.cwd(),
	RECURRENT_SPAM_STORAGE_FILE_NAME,
);

export type SpamRecurrentSource = "text_spam" | "ocr";

export type RecurrentSpamSubject = {
	guildId: string;
	authorId: string;
	authorTag: string;
	source: SpamRecurrentSource;
};

export type RecurrentSpamDecision = {
	enabled: boolean;
	shouldBan: boolean;
	counted: boolean;
	waveCount: number;
	allowedWaves: number;
	reason: "disabled" | "new_record" | "within_grace" | "counted" | "reset";
	lastCountedWaveAt: number | null;
	source: SpamRecurrentSource;
};

type RecurrentSpamRecord = {
	guildId: string;
	authorId: string;
	waveCount: number;
	firstWaveAt: number;
	lastWaveAt: number;
	lastCountedWaveAt: number;
	lastSource: SpamRecurrentSource;
	bannedAt?: number;
};

type RecurrentSpamStore = {
	version: 1;
	records: Record<string, RecurrentSpamRecord>;
};

let recurrentSpamStore: RecurrentSpamStore | null = null;
let recurrentSpamWriteQueue: Promise<void> = Promise.resolve();

function truncateEmbedField(value: string) {
	if (value.length <= MAX_EMBED_FIELD_VALUE_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_EMBED_FIELD_VALUE_LENGTH - 3)}...`;
}

function getDisabledRecurrentSpamDecision(
	source: SpamRecurrentSource,
): RecurrentSpamDecision {
	return {
		enabled: false,
		shouldBan: false,
		counted: false,
		waveCount: 0,
		allowedWaves: spamRecurrentAllowedWaves,
		reason: "disabled",
		lastCountedWaveAt: null,
		source,
	};
}

function getRecurrentSpamRecordKey(guildId: string, authorId: string) {
	return `${guildId}:${authorId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readFiniteNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readSource(value: unknown): SpamRecurrentSource {
	return value === "ocr" ? "ocr" : "text_spam";
}

function createEmptyRecurrentSpamStore(): RecurrentSpamStore {
	return { version: 1, records: {} };
}

function normalizeRecurrentSpamStore(value: unknown): RecurrentSpamStore {
	const store = createEmptyRecurrentSpamStore();
	if (!isRecord(value) || !isRecord(value.records)) {
		return store;
	}

	for (const rawRecord of Object.values(value.records)) {
		if (!isRecord(rawRecord)) {
			continue;
		}

		const guildId = typeof rawRecord.guildId === "string" ? rawRecord.guildId : null;
		const authorId =
			typeof rawRecord.authorId === "string" ? rawRecord.authorId : null;
		const waveCount = readFiniteNumber(rawRecord.waveCount);
		const lastWaveAt = readFiniteNumber(rawRecord.lastWaveAt);
		if (!guildId || !authorId || waveCount === null || lastWaveAt === null) {
			continue;
		}

		const lastCountedWaveAt =
			readFiniteNumber(rawRecord.lastCountedWaveAt) ?? lastWaveAt;
		const record: RecurrentSpamRecord = {
			guildId,
			authorId,
			waveCount: Math.max(1, Math.floor(waveCount)),
			firstWaveAt: readFiniteNumber(rawRecord.firstWaveAt) ?? lastCountedWaveAt,
			lastWaveAt,
			lastCountedWaveAt,
			lastSource: readSource(rawRecord.lastSource),
		};
		const bannedAt = readFiniteNumber(rawRecord.bannedAt);
		if (bannedAt !== null) {
			record.bannedAt = bannedAt;
		}

		store.records[getRecurrentSpamRecordKey(guildId, authorId)] = record;
	}

	return store;
}

function isNodeErrorWithCode(error: unknown, code: string) {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

async function loadRecurrentSpamStore() {
	if (recurrentSpamStore) {
		return recurrentSpamStore;
	}

	try {
		const content = await readFile(recurrentSpamStoragePath, "utf8");
		recurrentSpamStore = normalizeRecurrentSpamStore(JSON.parse(content));
	} catch (error) {
		if (!isNodeErrorWithCode(error, "ENOENT")) {
			debugLog("recurrent spam store load failed", {
				path: recurrentSpamStoragePath,
				error: formatError(error),
			});
		}
		recurrentSpamStore = createEmptyRecurrentSpamStore();
	}

	return recurrentSpamStore;
}

async function persistRecurrentSpamStore(store: RecurrentSpamStore) {
	await mkdir(path.dirname(recurrentSpamStoragePath), { recursive: true });
	const temporaryPath = `${recurrentSpamStoragePath}.${process.pid.toString()}.tmp`;
	await writeFile(
		temporaryPath,
		`${JSON.stringify(store, null, 2)}\n`,
		"utf8",
	);
	await rename(temporaryPath, recurrentSpamStoragePath);
}

async function saveRecurrentSpamStore(store: RecurrentSpamStore) {
	recurrentSpamWriteQueue = recurrentSpamWriteQueue
		.catch(() => undefined)
		.then(() => persistRecurrentSpamStore(store));

	try {
		await recurrentSpamWriteQueue;
	} catch (error) {
		debugLog("recurrent spam store save failed", {
			path: recurrentSpamStoragePath,
			error: formatError(error),
		});
		recurrentSpamWriteQueue = Promise.resolve();
	}
}

function pruneExpiredRecurrentSpamRecords(
	store: RecurrentSpamStore,
	now: number,
) {
	let changed = false;
	for (const [key, record] of Object.entries(store.records)) {
		if (now - record.lastWaveAt >= spamRecurrentResetMs) {
			delete store.records[key];
			changed = true;
		}
	}

	return changed;
}

export async function registerRecurrentSpamWave(
	subject: RecurrentSpamSubject,
): Promise<RecurrentSpamDecision> {
	if (!spamRecurrentBanUser) {
		return getDisabledRecurrentSpamDecision(subject.source);
	}

	const now = Date.now();
	const store = await loadRecurrentSpamStore();
	const pruned = pruneExpiredRecurrentSpamRecords(store, now);
	const key = getRecurrentSpamRecordKey(subject.guildId, subject.authorId);
	const existingRecord = store.records[key];
	let record = existingRecord;
	let reason: RecurrentSpamDecision["reason"];
	let counted = false;

	if (!record) {
		reason = "new_record";
		counted = true;
		record = {
			guildId: subject.guildId,
			authorId: subject.authorId,
			waveCount: 1,
			firstWaveAt: now,
			lastWaveAt: now,
			lastCountedWaveAt: now,
			lastSource: subject.source,
		};
		store.records[key] = record;
	} else if (now - record.lastWaveAt >= spamRecurrentResetMs) {
		reason = "reset";
		counted = true;
		record.waveCount = 1;
		record.firstWaveAt = now;
		record.lastWaveAt = now;
		record.lastCountedWaveAt = now;
		record.lastSource = subject.source;
		delete record.bannedAt;
	} else if (now - record.lastCountedWaveAt < spamRecurrentGraceMs) {
		reason = "within_grace";
		record.lastWaveAt = now;
		record.lastSource = subject.source;
	} else {
		reason = "counted";
		counted = true;
		record.waveCount += 1;
		record.lastWaveAt = now;
		record.lastCountedWaveAt = now;
		record.lastSource = subject.source;
	}

	const shouldBan = record.waveCount > spamRecurrentAllowedWaves;
	if (shouldBan) {
		record.bannedAt = now;
	}

	if (pruned || counted || reason === "within_grace" || shouldBan) {
		await saveRecurrentSpamStore(store);
	}

	const decision: RecurrentSpamDecision = {
		enabled: true,
		shouldBan,
		counted,
		waveCount: record.waveCount,
		allowedWaves: spamRecurrentAllowedWaves,
		reason,
		lastCountedWaveAt: record.lastCountedWaveAt,
		source: subject.source,
	};

	debugLog("recurrent spam state updated", {
		author: subject.authorTag,
		guildId: subject.guildId,
		decision,
		storagePath: recurrentSpamStoragePath,
	});

	return decision;
}

export function formatRecurrentSpamSummary(decision: RecurrentSpamDecision) {
	if (!decision.enabled) {
		return null;
	}

	return truncateEmbedField(
		[
			`Source: ${decision.source}`,
			`Status: ${decision.reason}`,
			`Counted: ${decision.counted ? "yes" : "no"}`,
			`Waves: ${decision.waveCount.toString()}/${decision.allowedWaves.toString()}`,
			`Action: ${decision.shouldBan ? "ban" : "normal policy"}`,
			`Grace: ${Math.floor(spamRecurrentGraceMs / MILLISECONDS_PER_MINUTE).toString()}m`,
			`Reset: ${Math.floor(spamRecurrentResetMs / MILLISECONDS_PER_DAY).toString()}d`,
		].join("\n"),
	);
}

export async function banRecurrentSpamMember(
	member: GuildMember,
	reason = "AOCR-X: recurrent spam",
) {
	if (!member.bannable) {
		debugLog("recurrent spam ban skipped", {
			reason: "member_not_bannable",
			author: member.user.tag,
		});
		return;
	}

	try {
		await member.ban({
			reason,
			deleteMessageSeconds: 0,
		});
		debugLog("recurrent spam ban applied", {
			author: member.user.tag,
		});
	} catch (error) {
		debugLog("recurrent spam ban failed", formatError(error));
	}
}
