import base64
import io
import json
import os
import tempfile
import threading
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image, ImageOps, UnidentifiedImageError

os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")
os.environ.setdefault("FLAGS_use_mkldnn", "0")


def detect_cpu_count():
    if hasattr(os, "sched_getaffinity"):
        try:
            return max(1, len(os.sched_getaffinity(0)))
        except OSError:
            pass

    return os.cpu_count() or 1


def read_positive_int_env(name, default):
    raw = os.getenv(name)
    if not raw:
        return default

    try:
        value = int(raw)
    except ValueError:
        return default

    return value if value > 0 else default


CPU_THREADS = read_positive_int_env("PADDLE_OCR_CPU_THREADS", detect_cpu_count())
os.environ.setdefault("OMP_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("MKL_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("NUMEXPR_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("CPU_NUM", str(CPU_THREADS))


HOST = os.getenv("PADDLE_OCR_HOST", "127.0.0.1")
PORT = int(os.getenv("PADDLE_OCR_PORT", "8000"))
LANG = os.getenv("PADDLE_OCR_LANG", "en").strip()
PADDLE_ENGINE = os.getenv("PADDLE_OCR_INFERENCE_ENGINE", "paddle").strip()
USE_DOC_ORIENTATION_CLASSIFY = os.getenv(
    "PADDLE_OCR_USE_DOC_ORIENTATION_CLASSIFY",
    "false",
).lower() in {"1", "true", "yes", "y"}
USE_DOC_UNWARPING = os.getenv("PADDLE_OCR_USE_DOC_UNWARPING", "false").lower() in {
    "1",
    "true",
    "yes",
    "y",
}
USE_TEXTLINE_ORIENTATION = os.getenv(
    "PADDLE_OCR_USE_TEXTLINE_ORIENTATION",
    "false",
).lower() in {"1", "true", "yes", "y"}
DOWNLOAD_TIMEOUT_SECONDS = int(os.getenv("PADDLE_OCR_DOWNLOAD_TIMEOUT_SECONDS", "20"))
SERVICE_VERSION = "2026-06-27-official-predict-cpu-auto-image-video-frame-endpoint"

OCR = None
OCR_LOADING = False
OCR_ERROR = None
OCR_LOCK = threading.Lock()


def make_ocr():
    from paddleocr import PaddleOCR

    kwargs = {
        "use_doc_orientation_classify": USE_DOC_ORIENTATION_CLASSIFY,
        "use_doc_unwarping": USE_DOC_UNWARPING,
        "use_textline_orientation": USE_TEXTLINE_ORIENTATION,
        "engine": PADDLE_ENGINE,
        "cpu_threads": CPU_THREADS,
    }
    if LANG:
        kwargs["lang"] = LANG

    print(f"PaddleOCR init kwargs: {kwargs}", flush=True)
    try:
        return PaddleOCR(**kwargs)
    except TypeError as error:
        if "cpu_threads" not in str(error):
            raise

        kwargs.pop("cpu_threads", None)
        print(
            "PaddleOCR does not accept cpu_threads; using environment thread limits only",
            flush=True,
        )
        print(f"PaddleOCR init kwargs: {kwargs}", flush=True)
        return PaddleOCR(**kwargs)


def load_ocr():
    global OCR
    global OCR_ERROR
    global OCR_LOADING

    if OCR is not None:
        return OCR

    with OCR_LOCK:
        if OCR is not None:
            return OCR

        OCR_LOADING = True
        OCR_ERROR = None
        try:
            OCR = make_ocr()
            print("PaddleOCR model ready", flush=True)
            return OCR
        except Exception as error:
            OCR_ERROR = error
            raise
        finally:
            OCR_LOADING = False


def warmup_ocr():
    try:
        load_ocr()
    except Exception:
        traceback.print_exc()


def start_warmup_thread():
    thread = threading.Thread(target=warmup_ocr, daemon=True)
    thread.start()


def get_health_status():
    return {
        "ok": OCR is not None and OCR_ERROR is None,
        "ready": OCR is not None,
        "loading": OCR_LOADING,
        "engine": "paddle",
        "paddleEngine": PADDLE_ENGINE,
        "cpuThreads": CPU_THREADS,
        "version": SERVICE_VERSION,
        "error": str(OCR_ERROR) if OCR_ERROR else None,
    }


def normalize_confidence(value):
    if not isinstance(value, (int, float)):
        return 0

    confidence = float(value)
    if confidence <= 1:
        confidence *= 100

    return max(0, min(100, confidence))


def to_builtin(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, dict):
        return {key: to_builtin(child) for key, child in value.items()}

    if isinstance(value, (list, tuple)):
        return [to_builtin(child) for child in value]

    for attribute_name in ("json", "to_json", "to_dict"):
        if not hasattr(value, attribute_name):
            continue

        attribute = getattr(value, attribute_name)
        try:
            converted = attribute() if callable(attribute) else attribute
        except TypeError:
            continue

        if isinstance(converted, str):
            try:
                converted = json.loads(converted)
            except json.JSONDecodeError:
                pass

        if converted is not value:
            return to_builtin(converted)

    if hasattr(value, "tolist"):
        try:
            return to_builtin(value.tolist())
        except TypeError:
            pass

    if hasattr(value, "item"):
        try:
            return to_builtin(value.item())
        except (TypeError, ValueError):
            pass

    if hasattr(value, "__dict__"):
        return to_builtin(vars(value))

    return str(value)


def append_text_piece(pieces, text, confidence=0):
    if not isinstance(text, str) or not text:
        return

    pieces.append({"text": text, "confidence": normalize_confidence(confidence)})


def collect_text(result, pieces):
    result = to_builtin(result)

    if isinstance(result, dict):
        rec_texts = result.get("rec_texts") or result.get("texts")
        rec_scores = result.get("rec_scores") or result.get("scores") or []
        if isinstance(rec_texts, list):
            for index, text in enumerate(rec_texts):
                confidence = rec_scores[index] if index < len(rec_scores) else 0
                append_text_piece(pieces, text, confidence)
            return

        text = (
            result.get("text")
            or result.get("rec_text")
            or result.get("transcription")
            or result.get("label")
            or result.get("value")
        )
        if isinstance(text, str):
            append_text_piece(
                pieces,
                text,
                result.get("confidence")
                or result.get("score")
                or result.get("rec_score")
                or result.get("probability"),
            )
            return

        for child in result.values():
            collect_text(child, pieces)
        return

    if not isinstance(result, list):
        return

    if len(result) >= 2 and isinstance(result[0], str):
        append_text_piece(pieces, result[0], result[1])
        return

    if (
        len(result) >= 2
        and isinstance(result[1], list)
        and len(result[1]) >= 2
        and isinstance(result[1][0], str)
    ):
        append_text_piece(pieces, result[1][0], result[1][1])
        return

    for child in result:
        collect_text(child, pieces)


def summarize_raw_result(result):
    builtin = to_builtin(result)
    text = json.dumps(builtin, ensure_ascii=False, default=str)
    return text[:4000]


def run_ocr(image_path):
    ocr = load_ocr()
    return ocr.predict(image_path)


def read_media(payload):
    image_base64 = payload.get("imageBase64")
    image_url = payload.get("imageUrl")
    content_type = payload.get("contentType")
    if not isinstance(content_type, str):
        content_type = None

    if isinstance(image_base64, str) and image_base64:
        return base64.b64decode(image_base64), content_type, image_url

    if isinstance(image_url, str) and image_url:
        with urllib.request.urlopen(
            image_url,
            timeout=DOWNLOAD_TIMEOUT_SECONDS,
        ) as response:
            return response.read(), response.headers.get("content-type"), image_url

    raise ValueError("Expected imageUrl or imageBase64")


def flatten_transparency(image):
    rgba_image = image.convert("RGBA")
    background = Image.new("RGB", rgba_image.size, (255, 255, 255))
    background.paste(rgba_image, mask=rgba_image.getchannel("A"))
    return background


def normalize_image_for_paddle(image):
    if getattr(image, "is_animated", False):
        image.seek(0)

    image = ImageOps.exif_transpose(image)
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        return flatten_transparency(image)

    if image.mode not in {"RGB", "L"}:
        return image.convert("RGB")

    return image.copy()

def get_media_suffix(content_type, image_url):
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    content_type_suffixes = {
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
        "image/gif": ".gif",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }
    if normalized_content_type in content_type_suffixes:
        return content_type_suffixes[normalized_content_type]

    if isinstance(image_url, str):
        path = urllib.parse.urlparse(image_url).path.lower()
        for suffix in (".mp4", ".m4v", ".mov", ".webm", ".gif", ".jpg", ".jpeg", ".png", ".webp"):
            if path.endswith(suffix):
                return suffix

    return ".media"


def normalize_video_frame_for_paddle(media_bytes, suffix):
    try:
        import cv2
    except ImportError as error:
        raise ValueError("Video OCR requires OpenCV in the Paddle container") from error

    media_path = None
    capture = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as media_file:
            media_file.write(media_bytes)
            media_path = media_file.name

        capture = cv2.VideoCapture(media_path)
        ok, frame = capture.read()
        if not ok or frame is None:
            raise ValueError("Unsupported or unreadable video format")

        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        return Image.fromarray(frame)
    finally:
        if capture is not None:
            capture.release()
        if media_path:
            try:
                os.unlink(media_path)
            except FileNotFoundError:
                pass

def write_image_file(payload):
    media_bytes, content_type, image_url = read_media(payload)
    try:
        with Image.open(io.BytesIO(media_bytes)) as image:
            normalized_image = normalize_image_for_paddle(image)
    except UnidentifiedImageError:
        suffix = get_media_suffix(content_type, image_url)
        normalized_image = normalize_video_frame_for_paddle(media_bytes, suffix)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as image_file:
        normalized_image.save(image_file, format="PNG")
        return image_file.name


def build_frame_response(payload):
    image_path = write_image_file(payload)
    try:
        with open(image_path, "rb") as image_file:
            image_base64 = base64.b64encode(image_file.read()).decode("ascii")

        return {
            "contentType": "image/png",
            "imageBase64": image_base64,
        }
    finally:
        try:
            os.unlink(image_path)
        except FileNotFoundError:
            pass


def build_response(payload):
    image_path = write_image_file(payload)
    try:
        result = run_ocr(image_path)
        pieces = []
        collect_text(result, pieces)
        text = "\n".join(piece["text"] for piece in pieces)
        confidence = (
            sum(piece["confidence"] for piece in pieces) / len(pieces)
            if pieces
            else 0
        )

        response = {
            "engine": "paddle",
            "paddleEngine": PADDLE_ENGINE,
            "cpuThreads": CPU_THREADS,
            "version": SERVICE_VERSION,
            "text": text,
            "confidence": confidence,
            "results": pieces,
        }

        if not pieces:
            response["rawSummary"] = summarize_raw_result(result)

        return response
    finally:
        try:
            os.unlink(image_path)
        except FileNotFoundError:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def send_json(self, status, body):
        response = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, get_health_status())
            return

        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in {"/ocr", "/frame"}:
            self.send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if self.path == "/frame":
                self.send_json(200, build_frame_response(payload))
                return

            self.send_json(200, build_response(payload))
        except Exception as error:
            traceback.print_exc()
            self.send_json(500, {"error": str(error)})


if __name__ == "__main__":
    start_warmup_thread()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"PaddleOCR service listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
