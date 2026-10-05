#!/usr/bin/env bash
# 本地一键启动（无需 Docker、无需安装任何依赖，Python 3.9+ 即可）
set -euo pipefail
cd "$(dirname "$0")"

export SEATLEASE_HOST="${SEATLEASE_HOST:-0.0.0.0}"
export SEATLEASE_PORT="${SEATLEASE_PORT:-8092}"
export SEATLEASE_DB="${SEATLEASE_DB:-$(pwd)/data/wal.jsonl}"
mkdir -p "$(dirname "$SEATLEASE_DB")"

echo "值班席位租约协调器 → http://localhost:${SEATLEASE_PORT}"
exec python3 backend/server.py
