const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();

function loadDotEnv() {
	const envPath = path.join(root, ".env");
	if (!fs.existsSync(envPath)) {
		return;
	}

	for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
		if (!match || process.env[match[1]] !== undefined) {
			continue;
		}

		process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
	}
}

loadDotEnv();

if (process.env.OCR_FORCE_TESSERACT_NOSIMD === "false") {
	console.log("[AOCR-X] Tesseract non-SIMD patch skipped by OCR_FORCE_TESSERACT_NOSIMD=false");
	process.exit(0);
}

const target = path.join(
	root,
	"node_modules",
	"tesseract.js",
	"src",
	"worker-script",
	"node",
	"getCore.js",
);

if (!fs.existsSync(target)) {
	console.log(`[AOCR-X] Tesseract getCore.js not found at ${target}; skipping patch`);
	process.exit(0);
}

const replacement = `'use strict';

const OEM = require('../../constants/OEM');

let TesseractCore = null;

module.exports = async (oem, _, res) => {
  if (TesseractCore === null) {
    const statusText = 'loading tesseract core';
    res.progress({ status: statusText, progress: 0 });

    if ([OEM.DEFAULT, OEM.LSTM_ONLY].includes(oem)) {
      TesseractCore = require('tesseract.js-core/tesseract-core-lstm');
    } else {
      TesseractCore = require('tesseract.js-core/tesseract-core');
    }

    res.progress({ status: statusText, progress: 1 });
  }

  return TesseractCore;
};
`;

const current = fs.readFileSync(target, "utf8");
if (current === replacement) {
	console.log("[AOCR-X] Tesseract non-SIMD patch already applied");
	process.exit(0);
}

const backup = `${target}.aocr-x-bak`;
if (!fs.existsSync(backup)) {
	fs.writeFileSync(backup, current);
}
fs.writeFileSync(target, replacement);
console.log("[AOCR-X] Tesseract non-SIMD patch applied");
