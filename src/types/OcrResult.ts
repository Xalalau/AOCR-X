export type OcrEngineName = "tesseract" | "paddle";

export type OcrResult = {
	engine: OcrEngineName;
	text: string;
	confidence: number;
	raw?: unknown;
};
