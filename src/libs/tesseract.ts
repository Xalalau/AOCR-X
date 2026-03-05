import { createScheduler, createWorker, PSM, type Worker } from "tesseract.js";

export const ocr = createScheduler();

export async function newWorkerWithConfig(): Promise<Worker> {
	//CUSTOM WORKER CONFIG HERE
	const worker = await createWorker("eng", 1, {
		langPath: ".",
		gzip: true,
		errorHandler(arg) {
			console.error(arg);
		},
	});
	await worker.setParameters({
		tessedit_pageseg_mode: PSM.SPARSE_TEXT,
	});
	return worker;
}

for (let i = 0; i < Number(process.env.WORKERS); ++i) {
	ocr.addWorker(await newWorkerWithConfig());
}

console.log(`${ocr.getNumWorkers().toString()} Workers prepared`);
