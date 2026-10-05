FROM python:3.11-slim

# 协调器仅依赖 Python 标准库（http.server + fsync JSONL WAL），无需 pip install
WORKDIR /app

COPY backend/ /app/backend/
COPY frontend/ /app/frontend/
COPY examples/ /app/examples/

RUN mkdir -p /app/data
ENV SEATLEASE_DB=/app/data/wal.jsonl \
    SEATLEASE_HOST=0.0.0.0 \
    SEATLEASE_PORT=8092 \
    SEATLEASE_NO_SEED=0 \
    PYTHONUNBUFFERED=1

EXPOSE 8092
VOLUME ["/app/data"]

HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8092/api/health',timeout=3).status==200 else 1)"

CMD ["python3", "/app/backend/server.py"]
