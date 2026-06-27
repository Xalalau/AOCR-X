import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcrEngineName, OcrResult } from "../types/OcrResult.js";
import {
	readBooleanConfig,
	readPositiveIntegerConfig,
} from "./config.js";
import { debugLog, formatError, normalizeWhitespace } from "./debug.js";

const DEFAULT_PADDLE_URL = "http://127.0.0.1:8000/ocr";
const DEFAULT_PADDLE_TIMEOUT_SECONDS = 120;
const MAX_ERROR_BODY_LENGTH = 1000;
const VIDEO_MEDIA_PATH_PATTERN = /\.(?:m4v|mov|mp4|webm)$/i;

class UnsupportedOcrInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedOcrInputError";
	}
}

type RecognizedPiece = {
	text: string;
	confidence: number;
};

type PaddlePayload = {
	imageUrl?: string;
	imageBase64?: string;
	contentType?: string;
};

type FramePayload = {
	imageBase64: string;
	contentType: string;
};

type TesseractInput = {
	image: string;
	temporaryPath?: string;
};

let tesseractModule:
	| typeof import("./tesseract.js")
	| undefined;

function getConfiguredEngine(): OcrEngineName {
	const rawEngine = process.env.OCR_ENGINE?.trim().toLowerCase();
	if (rawEngine === "paddle") {
		return "paddle";
	}
	if (rawEngine && rawEngine !== "tesseract") {
		debugLog("unknown OCR engine configured", {
			configuredEngine: rawEngine,
			fallbackEngine: "tesseract",
		});
	}

	return "tesseract";
}

function getPaddleUrl() {
	return process.env.OCR_PADDLE_URL?.trim() || DEFAULT_PADDLE_URL;
}

function getPaddleFrameUrl() {
	const url = new URL(getPaddleUrl());
	if (url.pathname.endsWith("/ocr")) {
		url.pathname = `${url.pathname.slice(0, -"/ocr".length)}/frame`;
	} else {
		url.pathname = `${url.pathname.replace(/\/$/, "")}/frame`;
	}

	return url.toString();
}

function getPaddleTimeoutMs() {
	return (
		readPositiveIntegerConfig(
			"OCR_PADDLE_TIMEOUT_SECONDS",
			DEFAULT_PADDLE_TIMEOUT_SECONDS,
		) * 1000
	);
}

function isTesseractFallbackEnabled() {
	return readBooleanConfig("OCR_PADDLE_FALLBACK_TO_TESSERACT", true);
}

function isAbortError(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "AbortError"
	);
}

function isUnsupportedOcrInputError(error: unknown) {
	return error instanceof UnsupportedOcrInputError;
}

function isVideoOcrInput(imageUrl: string, contentType?: string) {
	if (contentType?.startsWith("video/")) {
		return true;
	}

	try {
		return VIDEO_MEDIA_PATH_PATTERN.test(new URL(imageUrl).pathname);
	} catch {
		return VIDEO_MEDIA_PATH_PATTERN.test(imageUrl);
	}
}

function truncateErrorBody(value: string) {
	if (value.length <= MAX_ERROR_BODY_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_ERROR_BODY_LENGTH - 3)}...`;
}

function summarizeRawOcrResult(value: unknown) {
	try {
		return truncateErrorBody(JSON.stringify(value) ?? "");
	} catch {
		return "(unserializable OCR result)";
	}
}

function normalizeConfidence(value: unknown) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 0;
	}

	const percentage = value <= 1 ? value * 100 : value;
	return Math.max(0, Math.min(100, percentage));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readTextValue(value: Record<string, unknown>) {
	const text =
		value.text ??
		value.rec_text ??
		value.transcription ??
		value.label ??
		value.value;
	return typeof text === "string" ? text : null;
}

function readConfidenceValue(value: Record<string, unknown>) {
	return (
		value.confidence ??
		value.score ??
		value.rec_score ??
		value.probability ??
		value.accuracy
	);
}

function isFramePayload(value: unknown): value is FramePayload {
	return (
		isObject(value) &&
		typeof value.imageBase64 === "string" &&
		value.imageBase64.length > 0 &&
		typeof value.contentType === "string" &&
		value.contentType.length > 0
	);
}

function collectRecognizedPieces(value: unknown, pieces: RecognizedPiece[]) {
	if (Array.isArray(value)) {
		if (typeof value[0] === "string") {
			pieces.push({
				text: value[0],
				confidence: normalizeConfidence(value[1]),
			});
			return;
		}

		if (Array.isArray(value[1]) && typeof value[1][0] === "string") {
			pieces.push({
				text: value[1][0],
				confidence: normalizeConfidence(value[1][1]),
			});
			return;
		}

		for (const item of value) {
			collectRecognizedPieces(item, pieces);
		}
		return;
	}

	if (!isObject(value)) {
		return;
	}

	const text = readTextValue(value);
	if (text !== null) {
		pieces.push({
			text,
			confidence: normalizeConfidence(readConfidenceValue(value)),
		});
		return;
	}

	for (const child of Object.values(value)) {
		collectRecognizedPieces(child, pieces);
	}
}

function buildOcrResultFromPaddleResponse(responseBody: unknown): OcrResult {
	const pieces: RecognizedPiece[] = [];
	collectRecognizedPieces(responseBody, pieces);

	if (pieces.length === 0) {
		return {
			engine: "paddle",
			text: "",
			confidence: 0,
			raw: responseBody,
		};
	}

	const text = pieces.map((piece) => piece.text).join("\n");
	const confidence =
		pieces.reduce((total, piece) => total + piece.confidence, 0) / pieces.length;

	return {
		engine: "paddle",
		text,
		confidence,
		raw: responseBody,
	};
}

async function readResponseBody(response: Response) {
	try {
		return truncateErrorBody(await response.text());
	} catch (error) {
		return `failed to read response body: ${JSON.stringify(formatError(error))}`;
	}
}

async function buildPaddlePayload(
	imageUrl: string,
	signal: AbortSignal,
): Promise<PaddlePayload> {
	if (!readBooleanConfig("OCR_PADDLE_SEND_IMAGE_BASE64", true)) {
		return { imageUrl };
	}

	const response = await fetch(imageUrl, { signal });
	if (!response.ok) {
		throw new Error(
			`PaddleOCR image fetch returned HTTP ${response.status}: ${await readResponseBody(response)}`,
		);
	}

	const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
	if (
		contentType &&
		!contentType.startsWith("image/") &&
		!contentType.startsWith("video/")
	) {
		throw new UnsupportedOcrInputError(
			`OCR input is not image/video media: ${contentType}`,
		);
	}

	const imageBuffer = Buffer.from(await response.arrayBuffer());
	return {
		imageUrl,
		imageBase64: imageBuffer.toString("base64"),
		contentType,
	};
}

async function recognizeWithPaddle(imageUrl: string): Promise<OcrResult> {
	const controller = new AbortController();
	const timeoutMs = getPaddleTimeoutMs();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const payload = await buildPaddlePayload(imageUrl, controller.signal);
		debugLog("paddle OCR request", {
			url: getPaddleUrl(),
			mode: payload.imageBase64 ? "image_base64" : "image_url",
			contentType: payload.contentType ?? null,
			imageBytes: payload.imageBase64
				? Buffer.byteLength(payload.imageBase64, "base64")
				: null,
		});

		const response = await fetch(getPaddleUrl(), {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(
				`PaddleOCR service returned HTTP ${response.status}: ${await readResponseBody(response)}`,
			);
		}

		const responseBody: unknown = await response.json();
		const result = buildOcrResultFromPaddleResponse(responseBody);
		if (!payload.contentType) {
			return result;
		}

		return {
			...result,
			contentType: payload.contentType,
		};
	} catch (error) {
		if (controller.signal.aborted || isAbortError(error)) {
			throw new Error(
				`PaddleOCR request timed out after ${Math.floor(timeoutMs / 1000).toString()}s`,
			);
		}

		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function loadTesseractModule() {
	tesseractModule ??= await import("./tesseract.js");
	return tesseractModule;
}

async function recognizeWithTesseract(imageUrl: string) {
	const tesseract = await loadTesseractModule();
	return await tesseract.recognizeWithTesseract(imageUrl);
}

async function getTesseractInput(
	imageUrl: string,
	contentType?: string,
): Promise<TesseractInput> {
	if (!isVideoOcrInput(imageUrl, contentType)) {
		return { image: imageUrl };
	}

	const controller = new AbortController();
	const timeoutMs = getPaddleTimeoutMs();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const payload = await buildPaddlePayload(imageUrl, controller.signal);
		debugLog("tesseract frame extraction request", {
			url: getPaddleFrameUrl(),
			contentType: payload.contentType ?? contentType ?? null,
			mode: payload.imageBase64 ? "image_base64" : "image_url",
		});

		const response = await fetch(getPaddleFrameUrl(), {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(
				`PaddleOCR frame service returned HTTP ${response.status}: ${await readResponseBody(response)}`,
			);
		}

		const responseBody: unknown = await response.json();
		if (!isFramePayload(responseBody)) {
			throw new Error("PaddleOCR frame service returned an invalid frame payload");
		}

		const temporaryPath = join(
			tmpdir(),
			`aocr-tesseract-${process.pid.toString()}-${randomUUID()}.png`,
		);
		await writeFile(
			temporaryPath,
			Buffer.from(responseBody.imageBase64, "base64"),
		);

		return { image: temporaryPath, temporaryPath };
	} catch (error) {
		if (controller.signal.aborted || isAbortError(error)) {
			throw new Error(
				`PaddleOCR frame request timed out after ${Math.floor(timeoutMs / 1000).toString()}s`,
			);
		}

		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function recognizeMediaWithTesseract(
	imageUrl: string,
	contentType?: string,
) {
	const tesseractInput = await getTesseractInput(imageUrl, contentType);
	try {
		return await recognizeWithTesseract(tesseractInput.image);
	} finally {
		if (tesseractInput.temporaryPath) {
			try {
				await unlink(tesseractInput.temporaryPath);
			} catch (error) {
				debugLog("tesseract temporary frame cleanup failed", {
					path: tesseractInput.temporaryPath,
					error: formatError(error),
				});
			}
		}
	}
}

export async function recognizeImage(imageUrl: string): Promise<OcrResult> {
	const engine = getConfiguredEngine();

	if (engine === "paddle") {
		try {
			const result = await recognizeWithPaddle(imageUrl);
			debugLog("paddle OCR result", {
				confidence: result.confidence,
				text: normalizeWhitespace(result.text),
			});

			if (
				result.text.trim().length === 0 &&
				readBooleanConfig("OCR_PADDLE_FALLBACK_ON_EMPTY_TEXT", true)
			) {
				if (!isTesseractFallbackEnabled()) {
					throw new Error(
						`PaddleOCR returned empty text: ${summarizeRawOcrResult(result.raw)}`,
					);
				}

				debugLog("paddle OCR empty; falling back to tesseract", {
					contentType: result.contentType ?? null,
				});
				return await recognizeMediaWithTesseract(imageUrl, result.contentType);
			}

			return result;
		} catch (error) {
			if (isUnsupportedOcrInputError(error)) {
				throw error;
			}

			if (!isTesseractFallbackEnabled()) {
				throw error;
			}

			debugLog("paddle OCR failed; falling back to tesseract", {
				error: formatError(error),
			});
			return await recognizeMediaWithTesseract(imageUrl);
		}
	}

	return await recognizeMediaWithTesseract(imageUrl);
}

export async function shutdownOcr() {
	if (!tesseractModule) {
		return;
	}

	await tesseractModule.shutdownTesseract();
}
