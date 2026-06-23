# PaddleOCR service

This service keeps PaddleOCR outside the Discord bot process. It follows the official PaddleOCR 3.x API: `PaddleOCR(use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, engine="paddle")` and `ocr.predict(image_path)`. The bot sends either:

```json
{ "imageBase64": "..." }
```

or:

```json
{ "imageUrl": "https://..." }
```

and expects:

```json
{ "text": "...", "confidence": 93.5 }
```

## Docker

```sh
cd /root/AOCR-X
docker build -t aocr-x-paddle ./paddle-ocr-service
docker run -d --name aocr-x-paddle --restart unless-stopped -p 127.0.0.1:8000:8000 aocr-x-paddle
```

Check that it is listening:

```sh
wget -qO- http://127.0.0.1:8000/health; echo
# Confirm the response includes version=2026-06-22-official-predict-cpu-auto-image-normalize.
# During first model download/load, health returns ready=false. Wait for ready=true.
docker logs --tail=200 aocr-x-paddle
```

Then set the bot config:

```env
OCR_ENGINE=paddle
OCR_PADDLE_URL=http://127.0.0.1:8000/ocr
OCR_PADDLE_TIMEOUT_SECONDS=120
OCR_PADDLE_FALLBACK_TO_TESSERACT=true
OCR_PADDLE_SEND_IMAGE_BASE64=true
OCR_PADDLE_FALLBACK_ON_EMPTY_TEXT=true
```

## Image normalization

The service normalizes every input image with Pillow before calling PaddleOCR. Animated GIF/WEBP inputs use the first frame and are saved as a temporary PNG, which avoids Paddle image read errors on formats it cannot decode directly.

## CPU thread count

By default the service uses all CPUs visible to the container (`os.sched_getaffinity(0)`, falling back to `os.cpu_count()`). There is no fixed CPU count in the Dockerfile.

If you want to limit or override it, set:

```env
PADDLE_OCR_CPU_THREADS=4
```

The service also sets these variables to the same detected/overridden value unless they are already set: `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `NUMEXPR_NUM_THREADS`, and `CPU_NUM`.

Check the effective value with:

```sh
wget -qO- http://127.0.0.1:8000/health; echo
```

The response includes `cpuThreads`. On a 2-vCPU VM, it should show `"cpuThreads":2` without hardcoding that in the image.

## Direct Python

Using Docker is recommended on Alpine hosts. If you run it directly, use a glibc-based Python environment where `paddlepaddle` wheels are available.

```sh
cd /root/AOCR-X/paddle-ocr-service
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python server.py
```

## PaddleOCR fails with `ConvertPirAttribute2RuntimeAttribute`

This is a Paddle/PaddleOCR CPU inference issue in the oneDNN/MKLDNN path. The Docker image disables that path with:

```env
PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=0
FLAGS_use_mkldnn=0
```

After changing these values, rebuild the image with `--no-cache`.

## Container exits with code 132

If `docker container ls` shows `Restarting (132)`, the service is crashing before it opens port 8000. Exit code 132 usually means an illegal CPU instruction while loading Paddle/PaddleOCR, commonly because the VM CPU does not expose the instruction set required by the installed `paddlepaddle` wheel.

Confirm with:

```sh
docker logs --tail=200 aocr-x-paddle
grep -m1 flags /proc/cpuinfo
```
