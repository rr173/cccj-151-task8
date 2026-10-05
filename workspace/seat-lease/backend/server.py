"""值班席位租约协调器 —— HTTP 服务（Python 标准库，零第三方依赖）。

线程模型：ThreadingHTTPServer 接收请求；所有"读-改-写"都在协调器的
``commit_lock`` 内串行，状态变更以 fsync 的 WAL 事件为唯一提交点。

业务系统接入方式
================
现有服务在执行写操作前调用适配器校验：

    POST /api/fence/decide
      {"seat": "EVAC-1", "generation": 3, "fingerprint": "<幂等键>",
       "actor_id": "bob", "op": "evacuation_publish",
       "payload": {...}}
    200 -> {result:"accepted", response:{...}}     # 可执行业务（结果已确定）
    409 STALE_GENERATION / 423 GRACE_WINDOW ...     # 必须放弃本次写

内置三个业务演示端点（撤离方案发布 / 车队调度 / 封存审查）直接走同一判定路径。
"""
from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from coordinator import (
    Coordinator, DomainError, initial_state, reduce,
)
from seed import seed
from store import Store

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "frontend")
DATA_PATH = os.environ.get(
    "SEATLEASE_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data",
                 "wal.jsonl"))

# 业务操作名白名单（页面三个业务按钮 + 通用写入）
KNOWN_OPS = {
    "evacuation_publish": "撤离方案发布",
    "convoy_dispatch": "车队调度",
    "seal_review": "封存审查",
    "generic_write": "通用写操作",
}

store = Store(DATA_PATH)
coord = Coordinator(store)


# --------------------------------------------------------------- 启动播种

def ensure_seeded() -> None:
    if (os.environ.get("SEATLEASE_NO_SEED") == "1"
            or coord.state["seats"] or coord.state["people"]):
        return
    seed(coord)
    print("[seed] 已播种演示班次与席位", flush=True)


ensure_seeded()


# --------------------------------------------------------------- HTTP 处理器

class Handler(BaseHTTPRequestHandler):
    server_version = "SeatLease/1.0"

    # ---- 基础收发 ----
    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_domain_error(self, e: DomainError) -> None:
        self._send_json({
            "ok": False, "error": e.code, "message": e.message,
            "detail": e.detail,
        }, e.http_status)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise DomainError("INVALID_REQUEST", "请求体不是合法 JSON", 400)
        if not isinstance(data, dict):
            raise DomainError("INVALID_REQUEST", "请求体必须是 JSON 对象", 400)
        return data

    def _op(self, data: dict, required: tuple[str, ...] = ()):
        """统一取参与错误处理。返回 (args 字典, ) 或直接抛 DomainError。"""
        for key in required:
            if data.get(key) in (None, ""):
                raise DomainError("INVALID_REQUEST", f"缺少必填字段: {key}", 400)
        return data

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("[http] %s - %s\n" % (self.address_string(), fmt % args))

    # ---- 路由 ----
    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path == "/api/state":
                self._send_json({"ok": True, "state": coord.view()})
            elif path == "/api/events":
                self._send_json({"ok": True, "events": coord.events(500)})
            elif path == "/api/health":
                self._send_json({"ok": True, "time_ms": time.time() * 1000.0,
                                 "wal_seq": store.last_seq})
            elif path == "/" or path == "/index.html":
                self._serve_static("index.html", "text/html; charset=utf-8")
            elif path == "/styles.css":
                self._serve_static("styles.css", "text/css; charset=utf-8")
            elif path == "/app.js":
                self._serve_static("app.js", "application/javascript; charset=utf-8")
            else:
                self._send_json({"ok": False, "error": "NOT_FOUND",
                                 "message": path}, 404)
        except DomainError as e:
            self._send_domain_error(e)
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": "INTERNAL",
                             "message": repr(e)}, 500)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/people":
                p = coord.register_person(
                    data.get("person_id"), data.get("name", ""),
                    data.get("roles") or [],
                    bool(data.get("witness_qualified", False)))
                self._send_json({"ok": True, "person": p}, 201)

            elif path == "/api/people/witness-qualified":
                self._op(data, ("actor_id", "person_id"))
                p = coord.set_witness_qualified(
                    data["actor_id"], data["person_id"],
                    bool(data.get("qualified")))
                self._send_json({"ok": True, "person": p})

            elif path == "/api/shifts":
                self._op(data, ("actor_id", "name", "seats"))
                if not isinstance(data["seats"], list) or not data["seats"]:
                    raise DomainError("INVALID_REQUEST", "seats 必须是非空数组", 400)
                s = coord.create_shift(data["actor_id"], data["name"], data["seats"])
                self._send_json({"ok": True, "shift": s}, 201)

            elif path == "/api/seats/grant":
                self._op(data, ("seat", "holder_id"))
                seat = coord.grant_seat(
                    data["seat"], data["holder_id"],
                    data.get("ttl_ms"), data.get("grace_ms"))
                self._send_json({"ok": True, "seat": coord._seat_view(seat)})  # noqa: SLF001

            elif path == "/api/seats/heartbeat":
                self._op(data, ("seat", "actor_id", "generation"))
                view = coord.heartbeat(data["seat"], data["actor_id"],
                                       int(data["generation"]))
                self._send_json({"ok": True, "seat": view})

            elif path == "/api/handovers":
                self._op(data, ("seat", "actor_id", "successor_id"))
                h = coord.propose_handover(
                    data["seat"], data["actor_id"], data["successor_id"])
                self._send_json({"ok": True, "handover": h}, 201)

            elif path == "/api/handovers/confirm":
                self._op(data, ("handover_id", "actor_id"))
                h = coord.confirm_handover(data["handover_id"], data["actor_id"])
                self._send_json({"ok": True, "handover": h})

            elif path == "/api/handovers/release":
                self._op(data, ("handover_id", "actor_id"))
                h = coord.release_handover(data["handover_id"], data["actor_id"])
                self._send_json({"ok": True, "handover": h})

            elif path == "/api/handovers/cancel":
                self._op(data, ("handover_id", "actor_id"))
                h = coord.cancel_handover(
                    data["handover_id"], data["actor_id"],
                    data.get("reason", ""))
                self._send_json({"ok": True, "handover": h})

            elif path == "/api/takeovers":
                self._op(data, ("seat", "claimant_id"))
                tk = coord.start_takeover(
                    data["seat"], data["claimant_id"],
                    data.get("witness_ids") or [])
                self._send_json({"ok": True, "takeover": tk}, 201)

            elif path == "/api/takeovers/attest":
                self._op(data, ("takeover_id", "witness_id"))
                tk = coord.attest_takeover(
                    data["takeover_id"], data["witness_id"])
                self._send_json({"ok": True, "takeover": tk})

            elif path == "/api/takeovers/finalize":
                self._op(data, ("takeover_id", "actor_id"))
                tk = coord.finalize_takeover(
                    data["takeover_id"], data["actor_id"])
                self._send_json({"ok": True, "takeover": tk,
                                 "seat": next((s for s in coord.view()["seats"]
                                              if s["id"] == tk["seat"]), None)})

            elif path == "/api/fence/decide":
                verdict = self._run_decide(data)
                self._send_json({"ok": True, "verdict": verdict})

            elif path in ("/api/business/evacuation-publish",
                          "/api/business/convoy-dispatch",
                          "/api/business/seal-review"):
                op = {
                    "/api/business/evacuation-publish": "evacuation_publish",
                    "/api/business/convoy-dispatch": "convoy_dispatch",
                    "/api/business/seal-review": "seal_review",
                }[path]
                verdict = self._run_decide(data, default_op=op)
                self._send_json({"ok": True, "verdict": verdict})

            elif path == "/api/dev/reset":
                # 仅用于演示/自动化：清空 WAL 并重新播种
                store.reset()
                coord.state = store.recover(initial_state(), reduce)
                if os.environ.get("SEATLEASE_NO_SEED") != "1":
                    seed(coord)
                self._send_json({"ok": True, "state": coord.view()})

            elif path == "/api/dev/snapshot":
                info = coord.force_snapshot()
                self._send_json({"ok": True, "snapshot": info})

            else:
                self._send_json({"ok": False, "error": "NOT_FOUND",
                                 "message": path}, 404)
        except DomainError as e:
            self._send_domain_error(e)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self._send_json({"ok": False, "error": "INTERNAL",
                             "message": repr(e)}, 500)

    # ---- 适配器判定 ----
    def _run_decide(self, data: dict, default_op: str = "generic_write"):
        self._op(data, ("seat", "generation", "fingerprint"))
        op = data.get("op") or default_op
        if op not in KNOWN_OPS:
            raise DomainError("INVALID_REQUEST",
                              f"未知业务操作 {op!r}，允许: {sorted(KNOWN_OPS)}",
                              400)
        if "payload" not in data:
            raise DomainError("INVALID_REQUEST", "缺少 payload（请求内容）", 400)
        return coord.decide(
            data["seat"], int(data["generation"]), data["fingerprint"],
            data["payload"], data.get("actor_id"), op)

    def _serve_static(self, name: str, ctype: str) -> None:
        target = os.path.normpath(os.path.join(FRONTEND_DIR, name))
        if not target.startswith(os.path.abspath(FRONTEND_DIR)):
            self._send_json({"ok": False, "error": "FORBIDDEN"}, 403)
            return
        try:
            with open(target, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self._send_json({"ok": False, "error": "NOT_FOUND"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    host = os.environ.get("SEATLEASE_HOST", "0.0.0.0")
    port = int(os.environ.get("SEATLEASE_PORT", "8092"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"值班席位租约协调器 -> http://localhost:{port}  (WAL: {DATA_PATH})",
          flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[shutdown] 停止服务（WAL 已逐事件 fsync，安全退出）", flush=True)
    finally:
        httpd.server_close()
        store.close()


if __name__ == "__main__":
    main()
