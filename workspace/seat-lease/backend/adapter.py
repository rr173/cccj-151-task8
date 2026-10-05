"""供现有 Python 服务调用的租约围栏校验适配器（仅标准库）。

用法
====
    from adapter import LeaseFence, FenceRejected

    fence = LeaseFence("http://localhost:8092")

    @fence.guarded(op="evacuation_publish")
    def publish_evacuation(body, *, seat, generation, fingerprint, actor_id):
        # 走到这里说明：世代匹配、租约 ACTIVE、指纹/内容校验通过；
        # 抛 FenceRejected 即“旧控制台/已交班/重复指纹”等，业务必须放弃写入。
        ...

    # 或直接调用
    verdict = fence.decide(seat="EVAC-1", generation=3,
                           fingerprint="req-7781", actor_id="bob",
                           op="evacuation_publish", payload=body)

重试语义：同一 (fingerprint, payload) 的任意次重试都返回同一个 verdict
（首次可能带 replay=False，重试带 replay=True）；fingerprint 相同但
payload 不同 -> FenceRejected(reason=FINGERPRINT_REUSE)。
"""
from __future__ import annotations

import functools
import hashlib
import json
import urllib.error
import urllib.request
from typing import Any, Callable

FINGERPRINT_REUSE = "FINGERPRINT_REUSE"
STALE_GENERATION = "STALE_GENERATION"
GRACE_WINDOW = "GRACE_WINDOW"
LEASE_NOT_ACTIVE = "LEASE_NOT_ACTIVE"


class FenceRejected(Exception):
    """业务写操作必须据此中止；绝不可继续执行业务副作用。"""

    def __init__(self, reason: str, message: str, status: int,
                 detail: dict[str, Any] | None = None,
                 original_verdict: dict[str, Any] | None = None):
        super().__init__(f"[{reason}] {message}")
        self.reason = reason
        self.message = message
        self.status = status
        self.detail = detail or {}
        self.original_verdict = original_verdict

    @property
    def retryable_with_new_lease(self) -> bool:
        """调用方拿到新世代后可以重新发起（必须使用新指纹）。"""
        return self.reason in (STALE_GENERATION, GRACE_WINDOW, LEASE_NOT_ACTIVE)


def canonical_fingerprint(prefix: str, *parts: Any) -> str:
    """帮业务构造稳定指纹：规范化 JSON 后取 sha256 前 24 位。"""
    material = json.dumps([prefix, *parts], ensure_ascii=False,
                          sort_keys=True, separators=(",", ":"))
    return f"{prefix}-{hashlib.sha256(material.encode('utf-8')).hexdigest()[:24]}"


class LeaseFence:
    def __init__(self, base_url: str = "http://localhost:8092",
                 timeout: float = 5.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def decide(self, *, seat: str, generation: int, fingerprint: str,
               payload: Any, actor_id: str | None = None,
               op: str = "generic_write") -> dict[str, Any]:
        body = json.dumps({
            "seat": seat, "generation": int(generation),
            "fingerprint": fingerprint, "payload": payload,
            "actor_id": actor_id, "op": op,
        }, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/fence/decide", data=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                out = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8"))
            except Exception:  # noqa: BLE001
                err = {"error": "HTTP_ERROR", "message": str(e), "detail": {}}
            raise FenceRejected(
                err.get("error", "HTTP_ERROR"),
                err.get("message", ""), e.code,
                err.get("detail") or {}) from None
        return out["verdict"]

    def state(self) -> dict[str, Any]:
        with urllib.request.urlopen(f"{self.base_url}/api/state",
                                    timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))["state"]

    def guarded(self, op: str) -> Callable:
        """装饰器：被调函数 kwargs 必须含 seat/generation/fingerprint，
        actor_id 可选；payload 取自函数第一个位置参数（或 payload kwarg）。"""
        def deco(fn: Callable) -> Callable:
            @functools.wraps(fn)
            def wrapper(*args, **kwargs):
                try:
                    seat = kwargs.pop("seat")
                    generation = kwargs.pop("generation")
                    fingerprint = kwargs.pop("fingerprint")
                except KeyError as missing:
                    raise TypeError(
                        f"{fn.__name__} 需要围栏关键字参数 {missing}") from None
                actor_id = kwargs.pop("actor_id", None)
                payload = kwargs.pop("payload", args[0] if args else None)
                verdict = self.decide(
                    seat=seat, generation=generation, fingerprint=fingerprint,
                    payload=payload, actor_id=actor_id, op=op)
                # 判定已落盘；执行真实业务。业务异常不应重复执行——
                # 协调器保证同指纹重试永远拿到同一 verdict。
                result = fn(*args, **kwargs)
                return {"verdict": verdict, "result": result}
            return wrapper
        return deco
