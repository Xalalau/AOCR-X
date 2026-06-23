import { createScheduler, createWorker, PSM, type Worker } from "tesseract.js";
import type { OcrResult } from "../types/OcrResult.js";
import { readPositiveIntegerConfig } from "./config.js";
import { debugLog } from "./debug.js";

export const ocr = createScheduler();

export async function newWorkerWithConfig(): Promise<Worker> {
	//CUSTOM WORKER CONFIG HERE
	const worker = await createWorker("eng", 1, {
		langPath: ".",
		gzip: true,
		logger(arg) {
			debugLog("tesseract progress", arg);
		},
		errorHandler(arg) {
			console.error(arg);
		},
	});
	await worker.setParameters({
		tessedit_pageseg_mode: PSM.SPARSE_TEXT,
	});
	return worker;
}

const workerCount = readPositiveIntegerConfig("OCR_TESSERACT_WORKERS", 1);
for (let i = 0; i < workerCount; ++i) {
	ocr.addWorker(await newWorkerWithConfig());
}

console.log(`${ocr.getNumWorkers().toString()} Workers prepared`);

export async function recognizeWithTesseract(imageUrl: string): Promise<OcrResult> {
	const ocrData = await ocr.addJob("recognize", imageUrl);
	return {
		engine: "tesseract",
		text: ocrData.data.text,
		confidence: ocrData.data.confidence,
		raw: ocrData,
	};
}

export async function shutdownTesseract() {
	await ocr.terminate();
}
