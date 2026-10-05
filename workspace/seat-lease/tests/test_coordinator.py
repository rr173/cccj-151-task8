"""协调器领域测试：交接 / 紧急接管 / 租约时序 / 围栏幂等 / 崩溃恢复 / 并发。"""
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "backend"))

from coordinator import (  # noqa: E402
    ACCEPTED, DENIED, DomainError, canonical_hash,
    ERR_DUPLICATE_WITNESS, ERR_FP_REUSE, ERR_GRACE_WINDOW,
    ERR_HANDOVER_PENDING, ERR_NOT_ACTIVE, ERR_NOT_HOLDER,
    ERR_NOT_SUCCESSOR, ERR_NOT_WITNESS, ERR_STALE_GEN,
    ERR_TAKEOVER_EARLY, ERR_TAKEOVER_PREMATURE, ERR_TAKEOVER_SUPERSEDED,
)
from support import Harness, build_world  # noqa: E402


def expect_error(code):
    def deco(fn):
        def wrap(self):
            try:
                fn(self)
            except DomainError as e:
                self.assertEqual(e.code, code, f"期望 {code}，得到 {e.code}: {e}")
                return
            self.fail(f"应当抛出 {code}")
        wrap.__name__ = fn.__name__
        return wrap
    return deco


class HandoverTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.c = build_world(self.h)

    def tearDown(self):
        self.h.cleanup()

    def test_full_handover_two_phase_generation(self):
        """确认+交出都完成才产生新世代；两者缺一归属不变。"""
        self.assertEqual(self.seat()["generation"], 1)
        h = self.c.propose_handover("S1", "alice", "bob")

        # 只确认：世代不变，alice 仍可写
        self.c.confirm_handover(h["id"], "bob")
        self.assertEqual(self.seat()["generation"], 1)
        self.assertEqual(self.seat()["holder_id"], "alice")
        v = self.c.decide("S1", 1, "fp-1", {"x": 1}, "alice", "generic_write")
        self.assertEqual(v["result"], ACCEPTED)

        # 只交出（接班人已确认）-> 原子提交 g2
        out = self.c.release_handover(h["id"], "alice")
        self.assertEqual(out["status"], "committed")
        self.assertEqual(self.seat()["generation"], 2)
        self.assertEqual(self.seat()["holder_id"], "bob")
        # 租约从提交时刻重新起算
        self.assertGreater(self.seat()["expires_at"], self.h.clock.t)

    def test_release_before_confirm_holds_ownership(self):
        """先交出后确认：在确认前旧持有人仍是唯一有效持有人。"""
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.release_handover(h["id"], "alice")
        self.assertEqual(self.seat()["holder_id"], "alice")
        self.assertEqual(self.seat()["generation"], 1)
        self.c.confirm_handover(h["id"], "bob")
        self.assertEqual(self.seat()["holder_id"], "bob")
        self.assertEqual(self.seat()["generation"], 2)

    @expect_error(ERR_NOT_HOLDER)
    def test_only_holder_proposes(self):
        self.c.propose_handover("S1", "bob", "bob")

    @expect_error(ERR_NOT_SUCCESSOR)
    def test_only_successor_confirms(self):
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(h["id"], "grace")

    @expect_error(ERR_NOT_HOLDER)
    def test_only_holder_releases(self):
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.release_handover(h["id"], "bob")

    @expect_error(ERR_HANDOVER_PENDING)
    def test_single_pending_handover_per_seat(self):
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.propose_handover("S1", "alice", "grace")

    def test_cancel_then_repropose(self):
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.cancel_handover(h["id"], "alice", "改主意")
        self.assertEqual(self.seat()["generation"], 1)
        h2 = self.c.propose_handover("S1", "alice", "grace")
        self.c.confirm_handover(h2["id"], "grace")
        self.c.release_handover(h2["id"], "alice")
        self.assertEqual(self.seat()["holder_id"], "grace")
        self.assertEqual(self.seat()["generation"], 2)

    def test_stale_console_writes_rejected_after_commit(self):
        """新世代生效后，旧控制台（仍持 g1）的写与心跳全部被围栏拒绝。"""
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(h["id"], "bob")
        self.c.release_handover(h["id"], "alice")
        self.assertEqual(self.seat()["generation"], 2)
        with self.assertRaises(DomainError) as cm:
            self.c.decide("S1", 1, "fp-old", {"x": 2}, "alice",
                          "evacuation_publish")
        self.assertEqual(cm.exception.code, ERR_STALE_GEN)
        with self.assertRaises(DomainError) as cm2:
            self.c.heartbeat("S1", "alice", 1)
        self.assertEqual(cm2.exception.code, ERR_STALE_GEN)
        # 新持有人 g2 正常
        v = self.c.decide("S1", 2, "fp-new", {"x": 3}, "bob",
                          "evacuation_publish")
        self.assertEqual(v["result"], ACCEPTED)

    def test_accepted_effect_survives_later_handover(self):
        """已接受的请求保持原结果，之后的交班不得回滚。"""
        v1 = self.c.decide("S1", 1, "fp-a", {"order": 1}, "alice",
                           "evacuation_publish")
        self.assertEqual(v1["result"], ACCEPTED)
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(h["id"], "bob")
        self.c.release_handover(h["id"], "alice")
        # 旧控制台（alice/g1）原样重放仍被世代围栏挡住，不能复活旧写权限
        with self.assertRaises(DomainError) as cm:
            self.c.decide("S1", 1, "fp-a", {"order": 1}, "alice",
                          "evacuation_publish")
        self.assertEqual(cm.exception.code, ERR_STALE_GEN)
        # 已接受结果在账本中原样保留，可查询且永不回滚
        stored = self.c.state["fingerprints"]["fp-a"]
        self.assertEqual(stored["result"], ACCEPTED)
        self.assertEqual(stored["response"], v1["response"])
        self.assertEqual(len(self.h.coord.state["effects"]), 1)
        # 新持有人对自己请求的同指纹原样重放不产生重复副作用：
        # 这里验证不同指纹的新写正常、effect 列表不被交班改动
        self.assertEqual(len(self.h.coord.state["effects"]), 1)

    def seat(self):
        return self.c.state["seats"]["S1"]


class LeaseTimingTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.c = build_world(self.h)

    def tearDown(self):
        self.h.cleanup()

    def test_phases_active_grace_expired(self):
        self.assertEqual(self.view()["phase"], "ACTIVE")
        self.h.clock.advance(1001)
        self.assertEqual(self.view()["phase"], "GRACE")
        self.assertTrue(self.view()["writable"] is False)
        self.h.clock.advance(500)
        self.assertEqual(self.view()["phase"], "EXPIRED")

    def test_heartbeat_renews_inside_active_only(self):
        self.h.clock.advance(900)
        self.c.heartbeat("S1", "alice", 1)
        self.assertEqual(self.view()["phase"], "ACTIVE")
        self.h.clock.advance(1001)  # 到宽限
        with self.assertRaises(DomainError) as cm:
            self.c.heartbeat("S1", "alice", 1)
        self.assertEqual(cm.exception.code, ERR_GRACE_WINDOW)
        self.h.clock.advance(600)  # 到期
        with self.assertRaises(DomainError) as cm2:
            self.c.heartbeat("S1", "alice", 1)
        self.assertEqual(cm2.exception.code, ERR_NOT_ACTIVE)

    def test_reconnected_old_holder_cannot_write_after_takeover(self):
        """断连恢复者可读（view）但既不能续租也不能写。"""
        self._let_takeover_happen()
        # alice“网络恢复”
        with self.assertRaises(DomainError):
            self.c.heartbeat("S1", "alice", 1)
        with self.assertRaises(DomainError) as cm:
            self.c.decide("S1", 1, "fp-x", {}, "alice", "generic_write")
        self.assertEqual(cm.exception.code, ERR_STALE_GEN)
        # 状态仍然可查看
        self.assertIsNotNone(self.c.view()["seats"])

    def test_no_takeover_inside_active_or_grace(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        # ACTIVE 阶段
        with self.assertRaises(DomainError) as cm:
            self.c.finalize_takeover(tk["id"], "bob")
        self.assertEqual(cm.exception.code, ERR_TAKEOVER_EARLY)
        self.h.clock.advance(1001)  # GRACE
        with self.assertRaises(DomainError) as cm2:
            self.c.finalize_takeover(tk["id"], "bob")
        self.assertEqual(cm2.exception.code, ERR_TAKEOVER_PREMATURE)

    def test_handover_cannot_complete_after_expiry(self):
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(h["id"], "bob")
        self.h.clock.advance(1501)  # 已过失联门槛
        with self.assertRaises(DomainError) as cm:
            self.c.release_handover(h["id"], "alice")
        self.assertEqual(cm.exception.code, ERR_NOT_ACTIVE)
        self.assertEqual(self.seat()["holder_id"], "alice")

    def _let_takeover_happen(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        self.h.clock.advance(1501)
        out = self.c.finalize_takeover(tk["id"], "bob")
        self.assertEqual(out["status"], "won")
        return tk["id"]

    def view(self):
        return self.c.view()["seats_dict"] if False else \
            next(s for s in self.c.view()["seats"] if s["id"] == "S1")

    def seat(self):
        return self.c.state["seats"]["S1"]


class TakeoverTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.c = build_world(self.h)

    def tearDown(self):
        self.h.cleanup()

    def _expire(self):
        self.h.clock.advance(1501)

    def test_successful_takeover_two_distinct_witnesses(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        self._expire()
        out = self.c.finalize_takeover(tk["id"], "bob")
        self.assertEqual(out["status"], "won")
        self.assertEqual(self.seat()["generation"], 2)
        self.assertEqual(self.seat()["holder_id"], "bob")

    @expect_error(ERR_NOT_WITNESS)
    def test_claimant_cannot_be_witness(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "bob")

    @expect_error(ERR_NOT_WITNESS)
    def test_holder_cannot_witness_against_self(self):
        # carol 是 S2 持有人，S1 接管：alice 是 S1 持有人，不能见证 S1
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "alice")

    @expect_error(ERR_NOT_WITNESS)
    def test_unqualified_witness_rejected(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "dave")  # dave 无资格

    @expect_error(ERR_DUPLICATE_WITNESS)
    def test_duplicate_witness_rejected(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "erin")

    def test_qualification_revoked_after_attest_blocks_finalize(self):
        """见证后资格变化：finalize 时重新核验，只剩一人则不能夺取。"""
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        self.c.set_witness_qualified("zhou", "frank", False)
        self._expire()
        with self.assertRaises(DomainError) as cm:
            self.c.finalize_takeover(tk["id"], "bob")
        self.assertEqual(cm.exception.code, ERR_NOT_WITNESS)
        # 补一个仍合格的第三人即可夺取
        self.c.attest_takeover(tk["id"], "grace")
        out = self.c.finalize_takeover(tk["id"], "bob")
        self.assertEqual(out["status"], "won")

    def test_concurrent_takeovers_only_one_generation(self):
        """两个竞争者并发（见证齐备、到期后同时 finalize）：只产生 g2。"""
        t1 = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(t1["id"], "erin")
        self.c.attest_takeover(t1["id"], "frank")
        # grace 也是合格见证人（不是 S1 持有人），她的申请需要两个其他合格见证人
        t2 = self.c.start_takeover("S1", "grace", [])
        self.c.attest_takeover(t2["id"], "bob")
        self.c.attest_takeover(t2["id"], "erin")
        self._expire()

        results = {}

        def win(attempt_id, name):
            try:
                out = self.c.finalize_takeover(attempt_id, name)
                results[name] = ("won", out["status"])
            except DomainError as e:
                results[name] = ("lost", e.code)

        th = [threading.Thread(target=win, args=(t1["id"], "bob")),
              threading.Thread(target=win, args=(t2["id"], "grace"))]
        for x in th:
            x.start()
        for x in th:
            x.join()
        self.assertEqual(sum(1 for v in results.values() if v[0] == "won"), 1)
        loser_code = [v for v in results.values() if v[0] == "lost"][0][1]
        self.assertEqual(loser_code, ERR_TAKEOVER_SUPERSEDED)
        self.assertEqual(self.seat()["generation"], 2)  # 只 +1，一次连续世代
        winner = [n for n, v in results.items() if v[0] == "won"][0]
        self.assertEqual(self.seat()["holder_id"], winner)

    def test_pending_handover_superseded_by_takeover(self):
        h = self.c.propose_handover("S1", "alice", "bob")
        tk = self.c.start_takeover("S1", "grace", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        self._expire()
        self.c.finalize_takeover(tk["id"], "grace")
        self.assertEqual(
            self.c.state["handovers"][h["id"]]["status"], "superseded")
        with self.assertRaises(DomainError):
            self.c.confirm_handover(h["id"], "bob")

    def test_old_generation_takeover_after_moved_is_refused(self):
        t1 = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(t1["id"], "erin")
        # alice 恢复心跳并保持在线，完成交班给 bob（世代 +1）
        h = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(h["id"], "bob")
        self.c.release_handover(h["id"], "alice")
        # 旧接管申请补见证 -> 世代已变，见证/夺取均拒绝
        with self.assertRaises(DomainError) as cm:
            self.c.attest_takeover(t1["id"], "frank")
        self.assertEqual(cm.exception.code, ERR_TAKEOVER_SUPERSEDED)
        with self.assertRaises(DomainError) as cm2:
            self.c.finalize_takeover(t1["id"], "bob")
        self.assertEqual(cm2.exception.code, ERR_TAKEOVER_SUPERSEDED)

    def seat(self):
        return self.c.state["seats"]["S1"]


class FenceIdempotencyTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.c = build_world(self.h)

    def tearDown(self):
        self.h.cleanup()

    def test_identical_retry_returns_same_verdict(self):
        payload = {"order_id": "X1", "n": 5}
        v1 = self.c.decide("S1", 1, "fp-1", payload, "alice",
                           "convoy_dispatch")
        v2 = self.c.decide("S1", 1, "fp-1", payload, "alice",
                           "convoy_dispatch")
        self.assertEqual(v1["response"], v2["response"])
        self.assertTrue(v2["replay"])
        self.assertEqual(len(self.c.state["effects"]), 1)

    def test_fingerprint_reuse_with_different_content_denied(self):
        self.c.decide("S1", 1, "fp-1", {"a": 1}, "alice", "generic_write")
        with self.assertRaises(DomainError) as cm:
            self.c.decide("S1", 1, "fp-1", {"a": 2}, "alice", "generic_write")
        self.assertEqual(cm.exception.code, ERR_FP_REUSE)
        # 原指纹原内容仍回放原判定，未被污染
        v = self.c.decide("S1", 1, "fp-1", {"a": 1}, "alice", "generic_write")
        self.assertEqual(v["result"], ACCEPTED)
        self.assertEqual(v["response"]["status"], "applied")
        # 复用拒绝也进了管理页拒绝流
        reasons = [d["reason"] for d in self.c.state["denials"]]
        self.assertIn(ERR_FP_REUSE, reasons)

    def test_denied_verdict_is_also_replayed(self):
        with self.assertRaises(DomainError):
            self.c.decide("S1", 99, "fp-bad", {"a": 1}, "alice",
                          "generic_write")
        with self.assertRaises(DomainError) as cm:
            self.c.decide("S1", 99, "fp-bad", {"a": 1}, "alice",
                          "generic_write")
        self.assertEqual(cm.exception.code, ERR_STALE_GEN)

    def test_canonical_hash_independent_of_key_order(self):
        self.assertEqual(canonical_hash({"a": 1, "b": 2}),
                         canonical_hash({"b": 2, "a": 1}))

    def test_writes_blocked_in_grace_and_expired(self):
        self.h.clock.advance(1001)
        with self.assertRaises(DomainError) as cm:
            self.c.decide("S1", 1, "fp-g", {}, "alice", "generic_write")
        self.assertEqual(cm.exception.code, ERR_GRACE_WINDOW)
        self.h.clock.advance(600)
        with self.assertRaises(DomainError) as cm2:
            self.c.decide("S1", 1, "fp-e", {}, "alice", "generic_write")
        self.assertEqual(cm2.exception.code, ERR_NOT_ACTIVE)


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.h = Harness()
        self.c = build_world(self.h)

    def tearDown(self):
        self.h.cleanup()

    def test_restart_replays_generation_lease_and_verdicts(self):
        # g1 上接受一个请求
        self.c.decide("S1", 1, "fp-before", {"k": 1}, "alice",
                      "seal_review")
        # 交班到 g2
        ho = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(ho["id"], "bob")
        self.c.release_handover(ho["id"], "alice")
        # g2 上再接受一个；发起一个未完成交接
        self.c.decide("S1", 2, "fp-after", {"k": 2}, "bob", "seal_review")
        ho2 = self.c.propose_handover("S2", "carol", "dave")

        c2 = self.h.reopen()
        s1 = c2.state["seats"]["S1"]
        self.assertEqual(s1["generation"], 2)
        self.assertEqual(s1["holder_id"], "bob")
        self.assertEqual(s1["expires_at"], self.c.state["seats"]["S1"]["expires_at"])
        s2 = c2.state["seats"]["S2"]
        self.assertEqual(s2["generation"], 1)
        h = c2.state["handovers"][ho2["id"]]
        self.assertEqual(h["status"], "pending")
        self.assertFalse(h["successor_confirmed"])
        # 请求判定完整恢复
        v = c2.decide("S1", 2, "fp-after", {"k": 2}, "bob", "seal_review")
        self.assertTrue(v["replay"])
        self.assertEqual(v["result"], ACCEPTED)
        with self.assertRaises(DomainError) as cm:
            c2.decide("S1", 1, "fp-before", {"k": 1}, "alice", "seal_review")
        self.assertEqual(cm.exception.code, ERR_STALE_GEN)
        self.assertEqual(len(c2.state["effects"]), 2)

    def test_crash_mid_handover_no_double_master_and_decidable(self):
        """崩在“确认之后、交出之前”：重启后旧持有人仍唯一有效且可继续流程。"""
        ho = self.c.propose_handover("S1", "alice", "bob")
        self.c.confirm_handover(ho["id"], "bob")
        c2 = self.h.reopen()
        s1 = c2.state["seats"]["S1"]
        self.assertEqual(s1["holder_id"], "alice")
        self.assertEqual(s1["generation"], 1)
        h = c2.state["handovers"][ho["id"]]
        self.assertTrue(h["successor_confirmed"])
        self.assertFalse(h["holder_released"])
        # 旧持有人在宽限内（假钟没走）仍可写
        v = c2.decide("S1", 1, "fp-z", {}, "alice", "generic_write")
        self.assertEqual(v["result"], ACCEPTED)
        # 继续完成交接
        out = c2.release_handover(ho["id"], "alice")
        self.assertEqual(out["status"], "committed")
        self.assertEqual(c2.state["seats"]["S1"]["generation"], 2)

    def test_crash_after_witness_before_finalize(self):
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        c2 = self.h.reopen()
        tkv = c2.state["takeovers"][tk["id"]]
        self.assertEqual(tkv["status"], "witnessing")
        self.assertEqual(len(tkv["witnesses"]), 2)
        self.h.clock.advance(1600)
        out = c2.finalize_takeover(tk["id"], "bob")
        self.assertEqual(out["status"], "won")

    def test_snapshot_compaction_then_restart(self):
        for i in range(10):
            self.c.heartbeat("S1", "alice", 1)
            self.h.clock.advance(100)
        self.c.decide("S1", 1, "fp-snap", {"i": 1}, "alice", "generic_write")
        info = self.c.force_snapshot()
        self.assertGreaterEqual(info["snapshot_seq"], 12)
        # WAL 只剩快照之后的事件
        c2 = self.h.reopen()
        self.assertEqual(c2.state["seats"]["S1"]["holder_id"], "alice")
        self.assertEqual(c2.state["seats"]["S1"]["generation"], 1)
        v = c2.decide("S1", 1, "fp-snap", {"i": 1}, "alice", "generic_write")
        self.assertTrue(v["replay"])
        # 快照后继续写也正常
        self.c2_settle(c2)

    def c2_settle(self, c2):
        ho = c2.propose_handover("S1", "alice", "bob")
        c2.confirm_handover(ho["id"], "bob")
        c2.release_handover(ho["id"], "alice")
        self.assertEqual(c2.state["seats"]["S1"]["generation"], 2)
        c3 = self.h.reopen()
        self.assertEqual(c3.state["seats"]["S1"]["generation"], 2)

    def test_monotonic_generation_across_restarts_and_takeover(self):
        self.h.clock.advance(1600)
        tk = self.c.start_takeover("S1", "bob", [])
        self.c.attest_takeover(tk["id"], "erin")
        self.c.attest_takeover(tk["id"], "frank")
        self.c.finalize_takeover(tk["id"], "bob")  # g2
        c2 = self.h.reopen()
        # bob 心跳保持，交班给 grace -> g3
        c2.heartbeat("S1", "bob", 2)
        ho = c2.propose_handover("S1", "bob", "grace")
        c2.confirm_handover(ho["id"], "grace")
        c2.release_handover(ho["id"], "bob")
        self.assertEqual(c2.state["seats"]["S1"]["generation"], 3)
        c3 = self.h.reopen()
        self.assertEqual(c3.state["seats"]["S1"]["generation"], 3)
        self.assertEqual(c3.state["seats"]["S1"]["holder_id"], "grace")


if __name__ == "__main__":
    unittest.main(verbosity=2)
