#!/usr/bin/env python3
"""业务服务校验适配器（Python 参考实现，仅用标准库）。

用法：
    from adapter import LeaseFenceAdapter

    fence = LeaseFenceAdapter("http://localhost:8080", actor_id="u-evac")
    decision = fence.before_write(
        seat_id="seat-evac", generation=gen, op="evacuation",
        payload={"zones": ["A", "B"]},
    )
    if not decision["allowed"]:
        raise PermissionError(decision["reason"])
    if decision["replay"]:
        return decision["verdict"]      # 幂等重试：沿用原判定，不要重复执行
    do_real_write(decision["verdict"])
"""
import hashlib
import json
import secrets
import urllib.request


def _stable(x):
    if x is None or not isinstance(x, (dict, list)):
        return json.dumps(x, separators=(",", ":"), ensure_ascii=False)
    if isinstance(x, list):
        return "[" + ",".join(_stable(v) for v in x) + "]"
    return "{" + ",".join(
        json.dumps(k, ensure_ascii=False) + ":" + _stable(v)
        for k, v in sorted(x.items())
    ) + "}"


class FenceError(RuntimeError):
    def __init__(self, code, message, status=409):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.status = status


class LeaseFenceAdapter:
    def __init__(self, base_url="http://localhost:8080", actor_id=None):
        self.base_url = base_url.rstrip("/")
        self.actor_id = actor_id

    def payload_hash(self, payload):
        return hashlib.sha256(_stable(payload).encode("utf-8")).hexdigest()

    def _post(self, path, body):
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Actor-Id": self.actor_id or ""},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = json.loads(e.read().decode("utf-8"))
            return e.code, detail

    def heartbeat(self, seat_id, generation):
        status, raw = self._post("/api/heartbeat", {"seatId": seat_id, "generation": generation})
        if status != 200:
            raise FenceError(raw.get("error"), raw.get("message", ""), status)
        return raw

    def before_write(self, seat_id, generation, op, payload, fingerprint=None):
        fp = fingerprint or ("fp-" + secrets.token_hex(12))
        status, raw = self._post("/api/adapter/evaluate", {
            "seatId": seat_id,
            "generation": generation,
            "op": op,
            "payload": payload,
            "payloadHash": self.payload_hash(payload),
            "fingerprint": fp,
        })
        if status != 200:
            return {"allowed": False, "decision": "DENY", "reason": raw.get("error", str(status)),
                    "message": raw.get("message"), "fingerprint": fp, "raw": raw}
        decision = raw["decision"]
        return {
            "allowed": decision in ("ACCEPT", "ACCEPT_REPLAY"),
            "replay": decision == "ACCEPT_REPLAY",
            "decision": decision,
            "reason": raw.get("reason"),
            "verdict": raw.get("verdict"),
            "fingerprint": fp,
            "raw": raw,
        }
