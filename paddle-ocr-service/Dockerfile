FROM python:3.11-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates libgomp1 libglib2.0-0 libgl1 \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

ENV PADDLE_OCR_HOST=0.0.0.0
ENV PADDLE_OCR_PORT=8000
ENV PADDLE_OCR_LANG=en
ENV PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
ENV PYTHONUNBUFFERED=1
ENV PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=0
ENV FLAGS_use_mkldnn=0

EXPOSE 8000

CMD ["python", "server.py"]
