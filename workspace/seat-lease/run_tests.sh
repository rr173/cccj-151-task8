#!/usr/bin/env bash
# 一键运行全部自动化测试（无需安装任何第三方依赖）
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/2 协调器领域测试（33 项，假钟） =="
python3 -m unittest tests.test_coordinator -v

echo
echo "== 2/2 端到端测试（真实 HTTP / 子进程重启 / SIGKILL / 适配器） =="
python3 -m unittest tests.test_e2e -v
