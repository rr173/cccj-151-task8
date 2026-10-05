"""值班席位租约协调器 —— 领域核心（纯 Python 标准库）。

不变量（invariants）
====================
1. 一个席位任意时刻至多一个**有效持有人**；世代号 ``generation`` 单调不减、
   每次归属改变严格 +1。
2. 交接是两阶段提交：``successor_confirmed`` 与 ``holder_released`` 都置位时，
   reducer 原子产出 HANDOVER_COMMIT（新世代生效）。任一步骤前崩溃，
   原持有人在旧世代上仍然有效；交出后崩溃而提交未落盘的窗口不存在——
   交出与提交是同一条 fsync 记录。
3. 紧急接管：两名**互不相同、当前仍具备资格、且不是夺取人**的见证人
   先后见证；在 ``失联门槛 = last_heartbeat + ttl + grace_ms`` 到达之前
   finalize 一律拒绝；到点后并发接管只有一个新世代（其余请求看到世代已变，
   标记 SUPERSEDED 拒绝）。
4. 围栏：业务判定携带 (seat, generation, fingerprint, content_hash)。
   generation 非当前世代 -> DENY(STALE_GENERATION)；同指纹重试 ->
   回放原判定；同指纹但内容哈希不同 -> DENY(FINGERPRINT_REUSE)。
   已 ACCEPT 的判定永不被后来的交班/接管/重启改变。
5. 租约：now <= expires_at 为 ACTIVE；expires_at < now <= grace_until 为
   GRACE（不可续租、不可写，但任何人尚不能接管）；之后为 EXPIRED。

时间单位统一为毫秒。时钟来源由外部注入（``now_ms``），测试可注入假钟。
"""
from __future__ import annotations

import hashlib
import json
import threading
import uuid
from typing import Any, Callable

from store import Store

DENIED = "denied"
ACCEPTED = "accepted"

# 业务拒绝原因（机读码）
ERR_INVALID = "INVALID_REQUEST"
ERR_UNKNOWN_SEAT = "UNKNOWN_SEAT"
ERR_UNKNOWN_SHIFT = "UNKNOWN_SHIFT"
ERR_UNKNOWN_PERSON = "UNKNOWN_PERSON"
ERR_NOT_LEAD = "NOT_SHIFT_LEAD"
ERR_NOT_HOLDER = "NOT_HOLDER"
ERR_NOT_SUCCESSOR = "NOT_SUCCESSOR"
ERR_NOT_WITNESS = "NOT_WITNESS_ELIGIBLE"
ERR_DUPLICATE_WITNESS = "DUPLICATE_WITNESS"
ERR_NOT_ACTIVE = "LEASE_NOT_ACTIVE"
ERR_GRACE_WINDOW = "GRACE_WINDOW"
ERR_LEASE_HELD = "LEASE_STILL_HELD"
ERR_HANDOVER_PENDING = "HANDOVER_ALREADY_PENDING"
ERR_NO_HANDOVER = "NO_PENDING_HANDOVER"
ERR_STALE_GEN = "STALE_GENERATION"
ERR_TAKEOVER_SUPERSEDED = "TAKEOVER_SUPERSEDED"
ERR_TAKEOVER_PREMATURE = "TAKEOVER_PREMATURE"
ERR_TAKEOVER_EARLY = "TAKEOVER_TOO_EARLY"
ERR_FP_REUSE = "FINGERPRINT_REUSE"
ERR_UNKNOWN_ATTEMPT = "UNKNOWN_TAKEOVER_ATTEMPT"
ERR_NOT_WITNESS_LISTED = "WITNESS_NOT_ON_ATTEMPT"

DEFAULT_TTL_MS = 15_000
DEFAULT_GRACE_MS = 8_000
MAX_DENIALS = 300


class DomainError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 400,
                 detail: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.detail = detail or {}


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def canonical_hash(payload: Any) -> str:
    """对请求内容做规范化 SHA-256：字典按 key 排序、无空白分隔。"""
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def initial_state() -> dict[str, Any]:
    return {
        "people": {},          # pid -> {id,name,roles:[],witness_qualified}
        "shifts": {},          # sid -> {id,name,leader_id,created_at,open}
        "seats": {},           # seat -> {id,shift_id,ttl_ms,grace_ms,generation,
                               #          holder_id,expires_at,grace_until,last_heartbeat}
        "handovers": {},       # hid -> {...}
        "takeovers": {},       # tid -> {...}
        "fingerprints": {},    # fp -> 判定（永久，含 denied）
        "effects": [],         # 已接受写操作（不可变）
        "denials": [],         # 最近被围栏/状态机拒绝的操作（管理页展示）
    }


# ============================================================ 纯函数 reducer

def reduce(state: dict[str, Any], entry: dict[str, Any]) -> None:
    """把一条事件**原地**应用到 state。崩溃重放与在线提交共用此函数，必须确定。"""
    t = entry["type"]
    d = entry["data"]
    ts = entry["ts"]

    if t == "PERSON_REGISTERED":
        state["people"][d["id"]] = {
            "id": d["id"], "name": d["name"], "roles": list(d.get("roles", [])),
            "witness_qualified": bool(d.get("witness_qualified", False)),
        }
    elif t == "PERSON_QUALIFIED":
        if d["person_id"] in state["people"]:
            state["people"][d["person_id"]]["witness_qualified"] = d["qualified"]

    elif t == "SHIFT_CREATED":
        state["shifts"][d["id"]] = {
            "id": d["id"], "name": d["name"], "leader_id": d["leader_id"],
            "created_at": ts, "open": True,
        }

    elif t == "SEAT_DEFINED":
        state["seats"][d["id"]] = {
            "id": d["id"], "shift_id": d.get("shift_id"),
            "ttl_ms": d["ttl_ms"], "grace_ms": d["grace_ms"],
            "generation": 0, "holder_id": None,
            "expires_at": None, "grace_until": None, "last_heartbeat": None,
        }

    elif t in ("SEAT_GRANTED", "LEASE_HEARTBEAT"):
        seat = state["seats"][d["seat"]]
        seat["generation"] = d["generation"]
        seat["holder_id"] = d["holder_id"]
        seat["expires_at"] = d["expires_at"]
        seat["grace_until"] = d["grace_until"]
        seat["last_heartbeat"] = ts

    elif t == "HANDOVER_PROPOSED":
        state["handovers"][d["id"]] = dict(d)

    elif t == "HANDOVER_CONFIRMED":
        state["handovers"][d["id"]]["successor_confirmed"] = True

    elif t == "HANDOVER_RELEASED":
        state["handovers"][d["id"]]["holder_released"] = True

    elif t == "HANDOVER_COMMIT":
        seat = state["seats"][d["seat"]]
        seat["generation"] = d["generation"]
        seat["holder_id"] = d["holder_id"]
        seat["expires_at"] = d["expires_at"]
        seat["grace_until"] = d["grace_until"]
        seat["last_heartbeat"] = ts
        h = state["handovers"][d["handover_id"]]
        h["status"] = "committed"
        h["committed_at"] = ts
        h["generation"] = d["generation"]

    elif t == "HANDOVER_CANCELLED":
        state["handovers"][d["id"]]["status"] = "cancelled"
        state["handovers"][d["id"]]["cancelled_at"] = ts
        state["handovers"][d["id"]]["cancel_reason"] = d.get("reason", "")

    elif t == "TAKEOVER_STARTED":
        state["takeovers"][d["id"]] = {
            **d, "witnesses": [], "status": "witnessing",
        }

    elif t == "TAKEOVER_WITNESSED":
        tk = state["takeovers"][d["id"]]
        tk["witnesses"] = [dict(w) for w in d["witnesses"]]

    elif t == "TAKEOVER_FINALIZED":
        tk = state["takeovers"][d["id"]]
        tk["status"] = d["status"]
        tk["finalized_at"] = ts
        if d["status"] == "won":
            seat = state["seats"][d["seat"]]
            seat["generation"] = d["generation"]
            seat["holder_id"] = d["holder_id"]
            seat["expires_at"] = d["expires_at"]
            seat["grace_until"] = d["grace_until"]
            seat["last_heartbeat"] = ts
            # 接管成功使席位上一切进行中的交接/其他接管失效
            for h in state["handovers"].values():
                if h.get("seat") == d["seat"] and h.get("status") == "pending":
                    h["status"] = "superseded"
                    h["superseded_at"] = ts
                    h["cancel_reason"] = "superseded_by_takeover"
            for other in state["takeovers"].values():
                if (other.get("seat") == d["seat"] and other["id"] != d["id"]
                        and other.get("status") == "witnessing"):
                    other["status"] = "superseded"
                    other["superseded_at"] = ts

    elif t == "FENCE_DECISION":
        verdict = {
            "fingerprint": d["fingerprint"], "seat": d["seat"],
            "generation": d["generation"], "actor_id": d.get("actor_id"),
            "content_hash": d["content_hash"], "op": d.get("op"),
            "result": d["result"], "reason": d.get("reason"),
            "response": d.get("response"), "at": ts,
        }
        prior_verdict = state["fingerprints"].get(d["fingerprint"])
        # 指纹判定表对同一指纹保持**首次判定不可变**：
        # 后来的围栏拒绝（旧世代重试）或指纹复用拒绝只进入拒绝流，
        # 不能覆盖/回滚已接受的原结果。
        if prior_verdict is None:
            state["fingerprints"][d["fingerprint"]] = verdict
        if d["result"] == ACCEPTED:
            state["effects"].append(verdict)
        else:
            state["denials"].append(verdict)
            if len(state["denials"]) > MAX_DENIALS:
                del state["denials"][: len(state["denials"]) - MAX_DENIALS]

    elif t == "DENIAL":
        rec = {**d, "at": ts}
        state["denials"].append(rec)
        if len(state["denials"]) > MAX_DENIALS:
            del state["denials"][: len(state["denials"]) - MAX_DENIALS]

    else:  # pragma: no cover - 新事件类型必须显式处理
        raise RuntimeError(f"unknown event type: {t}")


# ================================================================= 协调器

class Coordinator:
    def __init__(self, store: Store, now_ms: Callable[[], float] | None = None):
        self.store = store
        self.now_ms = now_ms or (lambda: __import__("time").time() * 1000.0)
        self.commit_lock = threading.RLock()
        self.state = store.recover(initial_state(), reduce)
        self._events_since_snapshot = 0

    # ------------------------------------------------------------- 内部

    def now(self) -> float:
        return self.now_ms()

    def _commit(self, event_type: str, data: dict[str, Any]) -> dict[str, Any]:
        """fsync 一条事件并同步应用到内存态（提交点，持锁串行）。"""
        with self.commit_lock:
            entry = self.store.append(event_type, data, self.now())
            reduce(self.state, entry)
            self._events_since_snapshot += 1
            return entry

    def _deny(self, reason: str, message: str, *, op: str | None = None,
              seat: str | None = None, actor_id: str | None = None,
              fingerprint: str | None = None, generation: int | None = None,
              http_status: int = 400, detail: dict[str, Any] | None = None,
              persist: bool = True) -> None:
        if persist:
            self._commit("DENIAL", {
                "reason": reason, "message": message, "op": op,
                "seat": seat, "actor_id": actor_id,
                "fingerprint": fingerprint, "generation": generation,
            })
        raise DomainError(reason, message, http_status, detail)

    def _person(self, pid: str | None) -> dict[str, Any]:
        if not pid or pid not in self.state["people"]:
            self._deny(ERR_UNKNOWN_PERSON, f"未知人员: {pid!r}", http_status=404)
        return self.state["people"][pid]  # type: ignore[return-value]

    def _seat(self, seat: str) -> dict[str, Any]:
        if seat not in self.state["seats"]:
            self._deny(ERR_UNKNOWN_SEAT, f"未知席位: {seat!r}",
                       seat=seat, http_status=404)
        return self.state["seats"][seat]

    def _pending_handover(self, seat: str) -> dict[str, Any] | None:
        for h in self.state["handovers"].values():
            if h.get("seat") == seat and h.get("status") == "pending":
                return h
        return None

    @staticmethod
    def _lease_phase(seat: dict[str, Any], now: float) -> str:
        if not seat.get("holder_id"):
            return "VACANT"
        if now < seat["expires_at"]:
            return "ACTIVE"
        if now < seat["grace_until"]:
            return "GRACE"
        return "EXPIRED"

    def _maybe_complete_handover(self, h: dict[str, Any]) -> None:
        """确认+交出都完成时，原子提交新世代。"""
        if not (h.get("successor_confirmed") and h.get("holder_released")):
            return
        if h.get("status") != "pending":
            return
        seat = self._seat(h["seat"])
        if self._lease_phase(seat, self.now()) != "ACTIVE":
            # 等待期间租约已越过宽限边界：不能再用交接通道转移归属
            self._deny(ERR_NOT_ACTIVE,
                       "租约已失效，交接不能完成；请改走紧急接管",
                       op="complete_handover", seat=seat["id"],
                       actor_id=h["to_holder_id"], http_status=423)
        now = self.now()
        gen = seat["generation"] + 1
        ttl = seat["ttl_ms"]
        grace = seat["grace_ms"]
        self._commit("HANDOVER_COMMIT", {
            "id": new_id("hc"),
            "handover_id": h["id"],
            "seat": h["seat"],
            "from_holder_id": h["from_holder_id"],
            "holder_id": h["to_holder_id"],
            "generation": gen,
            "expires_at": now + ttl,
            "grace_until": now + ttl + grace,
        })

    # ------------------------------------------------------------- 人员

    def register_person(self, person_id: str, name: str,
                        roles: list[str] | None = None,
                        witness_qualified: bool = False) -> dict[str, Any]:
        with self.commit_lock:
            if not person_id:
                self._deny(ERR_INVALID, "person_id 不能为空", persist=False,
                           http_status=400)
            if person_id in self.state["people"]:
                return self.state["people"][person_id]
            self._commit("PERSON_REGISTERED", {
                "id": person_id, "name": name or person_id,
                "roles": roles or [],
                "witness_qualified": witness_qualified,
            })
            return self.state["people"][person_id]

    def set_witness_qualified(self, actor_id: str, target_id: str,
                              qualified: bool) -> dict[str, Any]:
        with self.commit_lock:
            self._person(actor_id)
            target = self._person(target_id)
            self._commit("PERSON_QUALIFIED", {
                "person_id": target["id"], "qualified": bool(qualified),
                "actor_id": actor_id,
            })
            return self.state["people"][target_id]

    # ------------------------------------------------------------- 班次/席位

    def create_shift(self, actor_id: str, name: str, seats: list[dict[str, Any]]
                     ) -> dict[str, Any]:
        """排班负责人建立班次并定义席位。seats: [{id,ttl_ms,grace_ms}]"""
        with self.commit_lock:
            actor = self._person(actor_id)
            if "shift_lead" not in actor["roles"]:
                self._deny(ERR_NOT_LEAD, "只有排班负责人可以建立班次",
                           actor_id=actor_id, http_status=403)
            shift_id = new_id("shift")
            self._commit("SHIFT_CREATED", {
                "id": shift_id, "name": name, "leader_id": actor_id,
            })
            for spec in seats:
                seat_id = str(spec.get("id") or "").strip()
                if not seat_id:
                    self._deny(ERR_INVALID, "席位 id 不能为空",
                               actor_id=actor_id, http_status=400)
                if seat_id in self.state["seats"]:
                    self._deny(ERR_INVALID, f"席位已存在: {seat_id}",
                               seat=seat_id, actor_id=actor_id, http_status=409)
                self._commit("SEAT_DEFINED", {
                    "id": seat_id, "shift_id": shift_id,
                    "ttl_ms": int(spec.get("ttl_ms") or DEFAULT_TTL_MS),
                    "grace_ms": int(spec.get("grace_ms") or DEFAULT_GRACE_MS),
                })
            # SEAT_DEFINED 不需要 reducer 分支：下一次授予前不会出现在视图中；
            # 为可重放，在同一事件里携带全部席位定义并由下面的扩展处理。
            return self.state["shifts"][shift_id]

    def grant_seat(self, seat: str, holder_id: str, ttl_ms: int | None = None,
                   grace_ms: int | None = None) -> dict[str, Any]:
        """班次初始派座（班次开启时的冷启动授权，gen 从 1 起）。"""
        with self.commit_lock:
            self._person(holder_id)
            now = self.now()
            existing = self.state["seats"].get(seat)
            if existing and existing.get("holder_id"):
                self._deny(ERR_LEASE_HELD, "席位已有持有人，应走交接或接管",
                           seat=seat, actor_id=holder_id, http_status=409)
            if existing:
                # 已在班次中定义：沿用席位自身的租约参数（显式传入可覆盖）
                ttl = int(ttl_ms or existing["ttl_ms"])
                grace = int(grace_ms or existing["grace_ms"])
            else:
                ttl = int(ttl_ms or DEFAULT_TTL_MS)
                grace = int(grace_ms or DEFAULT_GRACE_MS)
                # 允许未建班次时的独立席位（演示/测试方便）
                self._commit("SEAT_DEFINED", {
                    "id": seat, "ttl_ms": ttl, "grace_ms": grace,
                })
            self._commit("SEAT_GRANTED", {
                "seat": seat, "holder_id": holder_id,
                "generation": 1,
                "expires_at": now + ttl, "grace_until": now + ttl + grace,
            })
            return self.state["seats"][seat]

    def heartbeat(self, seat: str, actor_id: str, generation: int
                  ) -> dict[str, Any]:
        """续租心跳：持有人 + 当前世代 + 租约仍 ACTIVE 才接受。"""
        with self.commit_lock:
            self._person(actor_id)
            s = self._seat(seat)
            now = self.now()
            # 世代围栏优先于持有人判断：交班后旧持有人的旧世代心跳必须是 STALE
            if s["generation"] != generation:
                self._deny(ERR_STALE_GEN,
                           f"旧世代 {generation} 的心跳被拒绝（当前 {s['generation']}）",
                           op="heartbeat", seat=seat, actor_id=actor_id,
                           generation=generation, http_status=409,
                           detail={"current_generation": s["generation"]})
            if s.get("holder_id") != actor_id:
                self._deny(ERR_NOT_HOLDER, "心跳发送者不是当前持有人",
                           op="heartbeat", seat=seat, actor_id=actor_id,
                           generation=generation, http_status=403)
            phase = self._lease_phase(s, now)
            if phase == "GRACE":
                self._deny(ERR_GRACE_WINDOW, "租约已进入宽限边界，不能续租",
                           op="heartbeat", seat=seat, actor_id=actor_id,
                           generation=generation, http_status=423,
                           detail={"grace_until": s["grace_until"]})
            if phase == "EXPIRED":
                self._deny(ERR_NOT_ACTIVE, "租约已到期，不能续租",
                           op="heartbeat", seat=seat, actor_id=actor_id,
                           generation=generation, http_status=423)
            ttl, grace = s["ttl_ms"], s["grace_ms"]
            self._commit("LEASE_HEARTBEAT", {
                "seat": seat, "holder_id": actor_id,
                "generation": generation,
                "expires_at": now + ttl, "grace_until": now + ttl + grace,
            })
            return self._seat_view(s)

    # ------------------------------------------------------------- 交接

    def propose_handover(self, seat: str, actor_id: str, successor_id: str
                         ) -> dict[str, Any]:
        with self.commit_lock:
            self._person(actor_id)
            self._person(successor_id)
            s = self._seat(seat)
            if s.get("holder_id") != actor_id:
                self._deny(ERR_NOT_HOLDER, "只有当前持有人可以发起交接",
                           op="propose_handover", seat=seat, actor_id=actor_id,
                           http_status=403)
            if self._lease_phase(s, self.now()) != "ACTIVE":
                self._deny(ERR_NOT_ACTIVE, "租约不在有效期，不能交班；请走紧急接管",
                           op="propose_handover", seat=seat, actor_id=actor_id,
                           http_status=423)
            existing = self._pending_handover(seat)
            if existing:
                self._deny(ERR_HANDOVER_PENDING, "该席位已有待确认交接",
                           op="propose_handover", seat=seat, actor_id=actor_id,
                           http_status=409, detail={"handover_id": existing["id"]})
            hid = new_id("ho")
            self._commit("HANDOVER_PROPOSED", {
                "id": hid, "seat": seat,
                "from_holder_id": actor_id, "to_holder_id": successor_id,
                "from_generation": s["generation"],
                "successor_confirmed": False, "holder_released": False,
                "status": "pending",
            })
            return self.state["handovers"][hid]

    def confirm_handover(self, handover_id: str, actor_id: str) -> dict[str, Any]:
        with self.commit_lock:
            self._person(actor_id)
            h = self._get_pending_handover(handover_id, actor_id, "confirm")
            if h["to_holder_id"] != actor_id:
                self._deny(ERR_NOT_SUCCESSOR, "只有候选接班人可以确认",
                           op="confirm_handover", seat=h["seat"],
                           actor_id=actor_id, http_status=403)
            if h["successor_confirmed"]:
                self._deny(ERR_HANDOVER_PENDING, "接班人已确认，等待持有人交出",
                           op="confirm_handover", seat=h["seat"],
                           actor_id=actor_id, http_status=409)
            self._commit("HANDOVER_CONFIRMED", {"id": handover_id})
            self._maybe_complete_handover(self.state["handovers"][handover_id])
            return self.state["handovers"][handover_id]

    def release_handover(self, handover_id: str, actor_id: str) -> dict[str, Any]:
        with self.commit_lock:
            self._person(actor_id)
            h = self._get_pending_handover(handover_id, actor_id, "release")
            if h["from_holder_id"] != actor_id:
                self._deny(ERR_NOT_HOLDER, "只有当前持有人可以交出",
                           op="release_handover", seat=h["seat"],
                           actor_id=actor_id, http_status=403)
            if h["holder_released"]:
                self._deny(ERR_HANDOVER_PENDING, "已交出，等待接班人确认",
                           op="release_handover", seat=h["seat"],
                           actor_id=actor_id, http_status=409)
            self._commit("HANDOVER_RELEASED", {"id": handover_id})
            self._maybe_complete_handover(self.state["handovers"][handover_id])
            return self.state["handovers"][handover_id]

    def cancel_handover(self, handover_id: str, actor_id: str,
                        reason: str = "") -> dict[str, Any]:
        with self.commit_lock:
            self._person(actor_id)
            if handover_id not in self.state["handovers"]:
                self._deny(ERR_NO_HANDOVER, "交接不存在",
                           op="cancel_handover", actor_id=actor_id,
                           http_status=404)
            h = self.state["handovers"][handover_id]
            allowed = {h["from_holder_id"], h["to_holder_id"]}
            shift = self.state["shifts"].get(
                self.state["seats"][h["seat"]].get("shift_id", ""), {})
            if shift.get("leader_id"):
                allowed.add(shift["leader_id"])
            if actor_id not in allowed:
                self._deny(ERR_NOT_HOLDER, "无权取消该交接",
                           op="cancel_handover", seat=h["seat"],
                           actor_id=actor_id, http_status=403)
            if h.get("status") != "pending":
                self._deny(ERR_NO_HANDOVER, f"交接已结束: {h.get('status')}",
                           op="cancel_handover", seat=h["seat"],
                           actor_id=actor_id, http_status=409)
            self._commit("HANDOVER_CANCELLED", {
                "id": handover_id, "reason": reason or "cancelled",
                "actor_id": actor_id,
            })
            return self.state["handovers"][handover_id]

    def _get_pending_handover(self, handover_id: str, actor_id: str,
                              op: str) -> dict[str, Any]:
        h = self.state["handovers"].get(handover_id)
        if not h:
            self._deny(ERR_NO_HANDOVER, "交接不存在",
                       op=f"{op}_handover", actor_id=actor_id, http_status=404)
        if h.get("status") != "pending":  # type: ignore[union-attr]
            self._deny(ERR_NO_HANDOVER, f"交接已结束: {h.get('status')}",
                       op=f"{op}_handover", seat=h["seat"],  # type: ignore[union-attr]
                       actor_id=actor_id, http_status=409)
        return h  # type: ignore[return-value]

    # ------------------------------------------------------------- 紧急接管

    def start_takeover(self, seat: str, claimant_id: str,
                       witness_ids: list[str]) -> dict[str, Any]:
        """发起紧急接管并登记初始见证人（至少两人，可随后增补）。"""
        with self.commit_lock:
            self._person(claimant_id)
            s = self._seat(seat)
            if not s.get("holder_id"):
                self._deny(ERR_NOT_ACTIVE, "席位空缺，直接派座即可，无需接管",
                           op="start_takeover", seat=seat, actor_id=claimant_id,
                           http_status=409)
            for other in self.state["takeovers"].values():
                if (other.get("seat") == seat and other.get("status") == "witnessing"
                        and other.get("claimant_id") == claimant_id):
                    self._deny(ERR_HANDOVER_PENDING,
                               "你对该席位已有进行中的接管申请",
                               op="start_takeover", seat=seat,
                               actor_id=claimant_id, http_status=409,
                               detail={"takeover_id": other["id"]})
            self._validate_witness_list(seat, claimant_id, witness_ids, s)
            tid = new_id("tk")
            self._commit("TAKEOVER_STARTED", {
                "id": tid, "seat": seat, "claimant_id": claimant_id,
                "from_generation": s["generation"],
                "from_holder_id": s["holder_id"],
                "initial_witnesses": list(witness_ids),
            })
            if witness_ids:
                self._commit("TAKEOVER_WITNESSED", {
                    "id": tid,
                    "witnesses": [
                        {"person_id": w,
                         "qualified_at": self.state["people"][w]["witness_qualified"]}
                        for w in witness_ids],
                })
            return self._takeover_view(self.state["takeovers"][tid])

    def attest_takeover(self, takeover_id: str, witness_id: str) -> dict[str, Any]:
        with self.commit_lock:
            self._person(witness_id)
            tk = self.state["takeovers"].get(takeover_id)
            if not tk:
                self._deny(ERR_UNKNOWN_ATTEMPT, "接管申请不存在",
                           op="attest_takeover", actor_id=witness_id,
                           http_status=404)
            if tk.get("status") != "witnessing":
                self._deny(ERR_TAKEOVER_SUPERSEDED,
                           f"接管申请已结束: {tk.get('status')}",
                           op="attest_takeover", seat=tk["seat"],
                           actor_id=witness_id, http_status=409)
            s = self._seat(tk["seat"])
            if s["generation"] != tk["from_generation"]:
                self._mark_superseded(tk, "generation moved before attestation")
                self._deny(ERR_TAKEOVER_SUPERSEDED,
                           "席位世代已变化，该接管申请作废",
                           op="attest_takeover", seat=tk["seat"],
                           actor_id=witness_id, http_status=409)
            person = self.state["people"][witness_id]
            if not person["witness_qualified"]:
                self._deny(ERR_NOT_WITNESS, "该见证人已不具备见证资格",
                           op="attest_takeover", seat=tk["seat"],
                           actor_id=witness_id, http_status=403)
            if witness_id == tk["claimant_id"]:
                self._deny(ERR_NOT_WITNESS, "夺取人不能同时担任见证人",
                           op="attest_takeover", seat=tk["seat"],
                           actor_id=witness_id, http_status=403)
            if witness_id == s.get("holder_id"):
                self._deny(ERR_NOT_WITNESS, "当前持有人不能见证对自己的接管",
                           op="attest_takeover", seat=tk["seat"],
                           actor_id=witness_id, http_status=403)
            existing = {w["person_id"] for w in tk["witnesses"]}
            if witness_id in existing:
                self._deny(ERR_DUPLICATE_WITNESS,
                           "同一见证人不能重复见证",
                           op="attest_takeover", seat=tk["seat"],
                           actor_id=witness_id, http_status=409)
            witnesses = tk["witnesses"] + [{
                "person_id": witness_id,
                "qualified_at": True,
                "attested_at": self.now(),
            }]
            self._commit("TAKEOVER_WITNESSED",
                         {"id": takeover_id, "witnesses": witnesses})
            return self._takeover_view(self.state["takeovers"][takeover_id])

    def finalize_takeover(self, takeover_id: str, actor_id: str
                          ) -> dict[str, Any]:
        """见证齐备后夺取席位；必须已过失联门槛，且只能产生一个新世代。"""
        with self.commit_lock:
            tk = self.state["takeovers"].get(takeover_id)
            if not tk:
                self._deny(ERR_UNKNOWN_ATTEMPT, "接管申请不存在",
                           op="finalize_takeover", actor_id=actor_id,
                           http_status=404)
            if tk.get("status") != "witnessing":
                self._deny(ERR_TAKEOVER_SUPERSEDED,
                           f"接管申请已结束: {tk.get('status')}",
                           op="finalize_takeover", seat=tk["seat"],
                           actor_id=actor_id, http_status=409)
            s = self._seat(tk["seat"])

            # 世代围栏：另一个接管已经赢了 -> 本申请失败，不会再 +1
            if s["generation"] != tk["from_generation"]:
                self._mark_superseded(tk, "generation moved")
                self._deny(ERR_TAKEOVER_SUPERSEDED,
                           f"席位已进入世代 {s['generation']}，接管申请竞争失败",
                           op="finalize_takeover", seat=tk["seat"],
                           actor_id=actor_id, http_status=409,
                           detail={"current_generation": s["generation"]})

            # 见证人以 finalize 时刻的资格重新核验（防止见证后资格被取消）
            valid_witnesses: list[str] = []
            for w in tk["witnesses"]:
                pid = w["person_id"]
                p = self.state["people"].get(pid)
                if (p and p["witness_qualified"] and pid != tk["claimant_id"]
                        and pid != s.get("holder_id")):
                    if pid not in valid_witnesses:
                        valid_witnesses.append(pid)
            if len(valid_witnesses) < 2:
                self._deny(ERR_NOT_WITNESS,
                           f"需要两名具备资格且互不相同的见证人，当前有效 {len(valid_witnesses)} 人",
                           op="finalize_takeover", seat=tk["seat"],
                           actor_id=actor_id, http_status=403,
                           detail={"valid_witnesses": valid_witnesses})

            now = self.now()
            phase = self._lease_phase(s, now)
            if phase == "ACTIVE":
                self._deny(ERR_TAKEOVER_EARLY,
                           f"原持有人仍在有效心跳期（剩余 {int(s['expires_at'] - now)}ms），不能接管",
                           op="finalize_takeover", seat=tk["seat"],
                           actor_id=actor_id, http_status=423,
                           detail={"expires_at": s["expires_at"]})
            if phase == "GRACE":
                self._deny(ERR_TAKEOVER_PREMATURE,
                           f"失联宽限边界未到（还剩 {int(s['grace_until'] - now)}ms），不能接管",
                           op="finalize_takeover", seat=tk["seat"],
                           actor_id=actor_id, http_status=423,
                           detail={"grace_until": s["grace_until"]})

            gen = s["generation"] + 1
            ttl, grace = s["ttl_ms"], s["grace_ms"]
            self._commit("TAKEOVER_FINALIZED", {
                "id": takeover_id, "seat": tk["seat"],
                "claimant_id": tk["claimant_id"],
                "holder_id": tk["claimant_id"],
                "witness_ids": valid_witnesses[:2],
                "generation": gen, "status": "won",
                "expires_at": now + ttl, "grace_until": now + ttl + grace,
            })
            return self._takeover_view(self.state["takeovers"][takeover_id])

    def _mark_superseded(self, tk: dict[str, Any], reason: str) -> None:
        self._commit("TAKEOVER_FINALIZED", {
            "id": tk["id"], "seat": tk["seat"],
            "claimant_id": tk["claimant_id"], "holder_id": None,
            "witness_ids": [], "generation": None,
            "status": "superseded", "reason": reason,
        })

    def _validate_witness_list(self, seat: str, claimant_id: str,
                               witness_ids: list[str],
                               seat_obj: dict[str, Any]) -> None:
        seen: set[str] = set()
        for wid in witness_ids:
            self._person(wid)
            p = self.state["people"][wid]
            if not p["witness_qualified"]:
                self._deny(ERR_NOT_WITNESS, f"见证人 {wid} 不具备资格",
                           op="start_takeover", seat=seat,
                           actor_id=claimant_id, http_status=403)
            if wid == claimant_id:
                self._deny(ERR_NOT_WITNESS, "夺取人不能同时担任见证人",
                           op="start_takeover", seat=seat,
                           actor_id=claimant_id, http_status=403)
            if wid == seat_obj.get("holder_id"):
                self._deny(ERR_NOT_WITNESS, "当前持有人不能见证对自己的接管",
                           op="start_takeover", seat=seat,
                           actor_id=claimant_id, http_status=403)
            if wid in seen:
                self._deny(ERR_DUPLICATE_WITNESS,
                           f"见证人重复: {wid}",
                           op="start_takeover", seat=seat,
                           actor_id=claimant_id, http_status=409)
            seen.add(wid)

    # ------------------------------------------------------------- 围栏判定

    def decide(self, seat: str, generation: int, fingerprint: str,
               payload: Any, actor_id: str | None = None,
               op: str | None = None) -> dict[str, Any]:
        """业务适配器入口。返回原判定（含已落盘响应），拒绝时抛 DomainError。

        同一 ``fingerprint`` 的完全相同重试 -> 返回原判定（幂等）；
        复用指纹但内容不同 -> 持久化 DENY(FINGERPRINT_REUSE) 并拒绝；
        非当前世代 -> DENY(STALE_GENERATION)；租约失效 -> DENY(LEASE_*)。
        """
        with self.commit_lock:
            content_hash = canonical_hash(payload)
            if actor_id:
                self._person(actor_id)
            s = self._seat(seat)

            # 1) 围栏先行：旧世代/非持有人/租约失效一律拒绝，即使指纹曾被接受
            #    （交班后旧控制台的“原样重试”也不能复活旧写权限）。
            reason = None
            if s["generation"] != generation:
                reason = ERR_STALE_GEN
                msg = (f"世代围栏拒绝：请求世代 {generation}，当前世代 "
                       f"{s['generation']}（旧控制台/已交班/已接管）")
                status = 409
            elif not s.get("holder_id") or s["holder_id"] != actor_id:
                reason = ERR_NOT_HOLDER
                msg = "请求者不是席位当前持有人"
                status = 403
            else:
                phase = self._lease_phase(s, self.now())
                if phase == "GRACE":
                    reason = ERR_GRACE_WINDOW
                    msg = "租约处于宽限边界，写操作被拒绝"
                    status = 423
                elif phase == "EXPIRED":
                    reason = ERR_NOT_ACTIVE
                    msg = "租约已到期，写操作被拒绝"
                    status = 423
            if reason:
                # 完全相同的拒绝重试 -> 返回原判定（不再追加事件）
                prior = self.state["fingerprints"].get(fingerprint)
                if prior is not None and prior.get("result") == DENIED and \
                        prior.get("reason") == reason and \
                        prior["content_hash"] == content_hash and \
                        prior["generation"] == generation:
                    raise DomainError(reason, msg + "（原判定重试）", status,
                                     {"current_generation": s["generation"],
                                      "replay": True})
                self._commit("FENCE_DECISION", {
                    "fingerprint": fingerprint, "seat": seat,
                    "generation": generation, "actor_id": actor_id,
                    "content_hash": content_hash, "op": op,
                    "result": DENIED, "reason": reason,
                    "response": None,
                })
                raise DomainError(reason, msg, status,
                                 {"current_generation": s["generation"]})

            # 2) 围栏通过后才查幂等表
            prior = self.state["fingerprints"].get(fingerprint)
            if prior is not None:
                if prior["content_hash"] != content_hash:
                    self._commit("FENCE_DECISION", {
                        "fingerprint": fingerprint, "seat": seat,
                        "generation": generation, "actor_id": actor_id,
                        "content_hash": content_hash, "op": op,
                        "result": DENIED, "reason": ERR_FP_REUSE,
                        "response": None,
                    })
                    self._deny(ERR_FP_REUSE,
                               "请求指纹已被不同内容使用，拒绝指纹复用",
                               op=op or "fence", seat=seat, actor_id=actor_id,
                               fingerprint=fingerprint, generation=generation,
                               http_status=409, persist=False)
                # 完全相同重试：回放原判定（不再写事件）
                if prior["result"] == DENIED:
                    raise DomainError(prior.get("reason") or ERR_STALE_GEN,
                                      f"原判定为重试：{prior.get('reason')}",
                                      409 if prior.get("reason") == ERR_STALE_GEN else 403,
                                      dict(prior))
                return dict(prior, replay=True)

            # 通过围栏：记录不可变判定。业务结果由执行器在同一锁外执行，
            # 但判定本身先行落盘——同一指纹永远拿到同一结果。
            response = self._business_response(seat, op, payload)
            self._commit("FENCE_DECISION", {
                "fingerprint": fingerprint, "seat": seat,
                "generation": generation, "actor_id": actor_id,
                "content_hash": content_hash, "op": op,
                "result": ACCEPTED, "reason": None,
                "response": response,
            })
            return self.state["fingerprints"][fingerprint]

    @staticmethod
    def _business_response(seat: str, op: str | None, payload: Any) -> dict[str, Any]:
        """内置业务适配器的确定性结果（撤离发布/车队调度/封存审查同一路径）。"""
        op = op or "generic_write"
        ref = None
        if isinstance(payload, dict):
            ref = payload.get("reference") or payload.get("id") or payload.get("order_id")
        digest = canonical_hash({"op": op, "seat": seat, "payload": payload})[:16]
        return {
            "status": "applied",
            "op": op,
            "reference": ref or f"{op}-{digest}",
            "digest": digest,
        }

    # ------------------------------------------------------------- 视图

    def _seat_view(self, s: dict[str, Any]) -> dict[str, Any]:
        now = self.now()
        phase = self._lease_phase(s, now)
        holder = self.state["people"].get(s.get("holder_id") or "", None)
        return {
            "id": s["id"],
            "shift_id": s.get("shift_id"),
            "ttl_ms": s["ttl_ms"],
            "grace_ms": s["grace_ms"],
            "generation": s["generation"],
            "holder_id": s.get("holder_id"),
            "holder_name": holder["name"] if holder else None,
            "expires_at": s.get("expires_at"),
            "grace_until": s.get("grace_until"),
            "last_heartbeat": s.get("last_heartbeat"),
            "phase": phase,
            "ms_to_expiry": max(0, int(s["expires_at"] - now))
            if s.get("expires_at") else None,
            "ms_to_grace_end": max(0, int(s["grace_until"] - now))
            if s.get("grace_until") else None,
            "writable": phase == "ACTIVE",
        }

    def _handover_view(self, h: dict[str, Any]) -> dict[str, Any]:
        out = dict(h)
        for key in ("from_holder_id", "to_holder_id"):
            p = self.state["people"].get(h.get(key))
            out[key.replace("_id", "_name")] = p["name"] if p else None
        seat = self.state["seats"].get(h.get("seat"))
        out["current_generation"] = seat["generation"] if seat else None
        out["ready_to_commit"] = bool(
            h.get("successor_confirmed") and h.get("holder_released")
            and h.get("status") == "pending")
        return out

    def _takeover_view(self, tk: dict[str, Any]) -> dict[str, Any]:
        out = {k: v for k, v in tk.items()}
        claimant = self.state["people"].get(tk.get("claimant_id"))
        out["claimant_name"] = claimant["name"] if claimant else None
        seat = self.state["seats"].get(tk.get("seat"))
        now = self.now()
        if seat and seat.get("holder_id"):
            out["ms_to_grace_end"] = max(0, int(seat["grace_until"] - now))
            out["lease_phase"] = self._lease_phase(seat, now)
        ws = []
        for w in tk.get("witnesses", []):
            p = self.state["people"].get(w["person_id"])
            ws.append({
                "person_id": w["person_id"],
                "name": p["name"] if p else w["person_id"],
                "qualified_now": bool(p and p["witness_qualified"]),
            })
        out["witness_views"] = ws
        out["valid_witness_count"] = sum(1 for w in ws if w["qualified_now"])
        if tk.get("status") == "won" and seat is not None:
            out["generation"] = seat["generation"]
            out["holder_id"] = seat["holder_id"]
        out["can_finalize_now"] = (
            tk.get("status") == "witnessing"
            and seat is not None and seat["generation"] == tk["from_generation"]
            and out["valid_witness_count"] >= 2
            and self._lease_phase(seat, now) == "EXPIRED")
        return out

    def view(self) -> dict[str, Any]:
        with self.commit_lock:
            seats = [self._seat_view(s) for s in self.state["seats"].values()]
            seats.sort(key=lambda x: x["id"])
            handovers = [self._handover_view(h)
                         for h in self.state["handovers"].values()]
            handovers.sort(key=lambda h: h["id"], reverse=True)
            takeovers = [self._takeover_view(tk)
                         for tk in self.state["takeovers"].values()]
            takeovers.sort(key=lambda t: t["id"], reverse=True)
            people = sorted(self.state["people"].values(),
                            key=lambda p: p["id"])
            shifts = sorted(self.state["shifts"].values(),
                            key=lambda s: s["created_at"])
            pending = [h for h in handovers if h["status"] == "pending"]
            return {
                "server_time_ms": self.now(),
                "people": people,
                "shifts": shifts,
                "seats": seats,
                "handovers": handovers,
                "pending_handovers": pending,
                "takeovers": takeovers,
                "active_takeovers": [t for t in takeovers
                                     if t["status"] == "witnessing"],
                "effects": list(reversed(self.state["effects"][-100:])),
                "effect_count": len(self.state["effects"]),
                "denials": list(reversed(self.state["denials"][-100:])),
            }

    def events(self, limit: int = 200) -> list[dict[str, Any]]:
        return self.store.read_events(limit)

    def force_snapshot(self) -> dict[str, Any]:
        with self.commit_lock:
            seq = self.store.last_seq
            self.store.snapshot(self.state, seq)
            return {"snapshot_seq": seq, "events_compacted":
                    self._events_since_snapshot}
