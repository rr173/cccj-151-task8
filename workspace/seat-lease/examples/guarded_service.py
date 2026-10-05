"""现有业务服务接入示例：一个“撤离/车队/封存”微服务，所有写端点先过租约围栏。

运行：
    python3 examples/guarded_service.py            # 业务服务 :8095
    python3 backend/server.py                      # 协调器   :8092

请求头携带席位凭证：
    X-Seat / X-Generation / X-Fingerprint / X-Actor
被围栏拒绝时本服务直接返回协调器给的机读原因，不执行任何业务副作用。
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "backend"))
from adapter import FenceRejected, LeaseFence  # noqa: E402

fence = LeaseFence(os.environ.get("SEATLEASE_URL", "http://localhost:8092"))

OPS = {
    "/business/evacuation-publish": "evacuation_publish",
    "/business/convoy-dispatch": "convoy_dispatch",
    "/business/seal-review": "seal_review",
}


class BusinessHandler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0]
        op = OPS.get(path)
        if not op:
            self._send({"error": "NOT_FOUND"}, 404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        try:
            verdict = fence.decide(
                seat=self.headers["X-Seat"],
                generation=int(self.headers["X-Generation"]),
                fingerprint=self.headers["X-Fingerprint"],
                actor_id=self.headers.get("X-Actor"),
                op=op, payload=payload)
        except FenceRejected as rej:
            self._send({"rejected": True, "reason": rej.reason,
                        "message": rej.message, "detail": rej.detail},
                       rej.status)
            return
        except Exception as e:  # noqa: BLE001  协调器不可达时必须安全失败
            self._send({"rejected": True, "reason": "FENCE_UNAVAILABLE",
                        "message": f"无法完成租约校验，拒绝写入: {e}"}, 503)
            return
        self._send({"applied": True, "coordinator_verdict": verdict,
                    "note": f"{op} 已在业务服务执行（演示桩）"})

    def _send(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[biz] %s\n" % (fmt % args))


if __name__ == "__main__":
    port = int(os.environ.get("BIZ_PORT", "8095"))
    ThreadingHTTPServer(("0.0.0.0", port), BusinessHandler).serve_forever()
