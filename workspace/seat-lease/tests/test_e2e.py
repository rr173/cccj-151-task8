"""端到端测试：真实 HTTP 服务（真实时钟、短租约）+ 子进程重启 + 适配器客户端。

覆盖：
* 正常交班全链路（确认/交出/旧控制台围栏拒绝/心跳）；
* 断连 -> 宽限期不可接管 -> 到期后并发接管只产生一个更大世代 -> 旧持有人恢复；
* 指纹幂等（同重试原判定、复用不同内容拒绝）；
* 进程杀掉重启：世代单调、租约边界、请求判定全部恢复；
* 校验适配器（LeaseFence）与被保护业务服务 examples/guarded_service.py。
"""
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(HERE, "..", "backend")
EXAMPLES = os.path.join(HERE, "..", "examples")
sys.path.insert(0, BACKEND)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_ready(port: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(0.15)
    raise RuntimeError(f"服务未就绪: {last}")


def req(port: str, path: str, body=None, method="POST", raw=False):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, headers=headers,
        method=method)
    try:
        with urllib.request.urlopen(r, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return (payload, resp.status) if raw else payload
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read().decode("utf-8"))
        if raw:
            return payload, e.code
        err = Exception(payload.get("message", str(e)))
        err.payload = payload
        err.code = payload.get("error")
        err.status = e.code
        raise err


class ServerProc:
    def __init__(self, db_path: str, port: int, seed_env: str = "0"):
        self.db_path = db_path
        self.port = port
        env = dict(os.environ)
        env.update({
            "SEATLEASE_DB": db_path,
            "SEATLEASE_PORT": str(port),
            "SEATLEASE_HOST": "127.0.0.1",
            "SEATLEASE_NO_SEED": seed_env,
            "PYTHONPATH": BACKEND,
            "PYTHONUNBUFFERED": "1",
        })
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(BACKEND, "server.py")],
            env=env, cwd=BACKEND,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    def stop(self):
        self.proc.send_signal(signal.SIGINT)
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)

    def kill9(self):
        """模拟断电/崩溃：SIGKILL，无优雅退出、无进程内清理。"""
        self.proc.kill()
        self.proc.wait(timeout=5)

    def restart(self):
        self.stop()
        new = ServerProc(self.db_path, self.port)
        new.start()
        return new

    def hard_restart(self):
        self.kill9()
        new = ServerProc(self.db_path, self.port)
        new.start()
        return new

    def start(self):
        wait_ready(self.port)
        return self


class E2ETest(unittest.TestCase):
    proc = None
    tmpdir = None

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="seatlease-e2e-")
        cls.db = os.path.join(cls.tmpdir, "wal.jsonl")
        cls.port = free_port()
        cls.proc = ServerProc(cls.db, cls.port).start()
        # 用自定义短租约世界（默认播种的 15s 不适合 e2e）
        req(cls.port, "/api/dev/reset", {})
        cls._seed_short_world()

    @classmethod
    def tearDownClass(cls):
        cls.proc.stop()

    @classmethod
    def _seed_short_world(cls):
        p = cls.port
        for pid, name, wq, roles in [
            ("zhou", "周班", False, ["shift_lead"]),
            ("alice", "Alice", True, []),
            ("bob", "Bob", True, []),
            ("erin", "Erin", True, []),
            ("frank", "Frank", True, []),
            ("grace", "Grace", True, []),
        ]:
            req(p, "/api/people", {"person_id": pid, "name": name,
                                   "witness_qualified": wq, "roles": roles})
        req(p, "/api/shifts", {"actor_id": "zhou", "name": "E2E 班",
                               "seats": [{"id": "E1", "ttl_ms": 2500,
                                          "grace_ms": 2500}]})
        req(p, "/api/seats/grant", {"seat": "E1", "holder_id": "alice"})

    def state(self):
        return req(self.port, "/api/state", method="GET")["state"]

    def seat(self):
        return next(s for s in self.state()["seats"] if s["id"] == "E1")

    # ------------------------------------------------------------ 正常交班

    def test_01_normal_handover_full_flow(self):
        p = self.port
        # 持座写操作成功
        fp = f"e2e-{time.time_ns()}"
        out = req(p, "/api/business/evacuation-publish", {
            "seat": "E1", "generation": 1, "actor_id": "alice",
            "fingerprint": fp, "payload": {"order_id": "ZONE-A"}})
        self.assertEqual(out["verdict"]["result"], "accepted")
        self.assertFalse(out["verdict"].get("replay"))

        # 相同重试 -> 原判定 replay
        out2 = req(p, "/api/business/evacuation-publish", {
            "seat": "E1", "generation": 1, "actor_id": "alice",
            "fingerprint": fp, "payload": {"order_id": "ZONE-A"}})
        self.assertTrue(out2["verdict"]["replay"])
        self.assertEqual(out2["verdict"]["response"],
                         out["verdict"]["response"])

        # 复用指纹改内容 -> 409 FINGERPRINT_REUSE
        err, status = req(p, "/api/business/evacuation-publish", {
            "seat": "E1", "generation": 1, "actor_id": "alice",
            "fingerprint": fp, "payload": {"order_id": "ZONE-B"}}, raw=True)
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "FINGERPRINT_REUSE")

        # 两阶段交接
        ho = req(p, "/api/handovers", {"seat": "E1", "actor_id": "alice",
                                       "successor_id": "bob"})["handover"]
        req(p, "/api/handovers/confirm", {"handover_id": ho["id"],
                                          "actor_id": "bob"})
        # 只确认时旧持有人仍可写
        self.assertEqual(self.seat()["holder_id"], "alice")
        done = req(p, "/api/handovers/release", {"handover_id": ho["id"],
                                                 "actor_id": "alice"})
        self.assertEqual(done["handover"]["status"], "committed")
        self.assertEqual(self.seat()["generation"], 2)
        self.assertEqual(self.seat()["holder_id"], "bob")

        # 旧控制台 alice/g1 写被拒 STALE_GENERATION
        err, status = req(p, "/api/fence/decide", {
            "seat": "E1", "generation": 1, "actor_id": "alice",
            "fingerprint": f"stale-{time.time_ns()}",
            "op": "generic_write", "payload": {}}, raw=True)
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "STALE_GENERATION")
        # 旧控制台心跳也被世代围栏拒绝
        err, status = req(p, "/api/seats/heartbeat", {
            "seat": "E1", "actor_id": "alice", "generation": 1}, raw=True)
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "STALE_GENERATION")

        # 新持有人写成功
        ok = req(p, "/api/fence/decide", {
            "seat": "E1", "generation": 2, "actor_id": "bob",
            "fingerprint": f"bob-{time.time_ns()}",
            "op": "convoy_dispatch", "payload": {"truck": "V9"}})
        self.assertEqual(ok["verdict"]["result"], "accepted")

    # ------------------------------------------------------------ 断连与接管

    def test_02_disconnect_grace_and_concurrent_takeover(self):
        p = self.port
        holder = self.seat()["holder_id"]
        self.assertIn(holder, ("bob", "alice"))
        gen = self.seat()["generation"]  # g1 或 g2
        # 合格见证人池（除持有人外）：alice/bob/erin/frank/grace 均有资格
        pool = [x for x in ["alice", "bob", "grace", "erin", "frank"]
                if x != holder]
        claimant1, claimant2 = pool[0], pool[1]
        w1, w2 = pool[2], pool[3]
        # 竞争者2需要两个与 claimant1 申请不同来源但可以相同人的见证人；
        # 取除持有人、claimant2 之外的两人
        pool2 = [x for x in pool if x != claimant2]
        x1, x2 = pool2[0], pool2[1]

        # 持有人控制台断连，停止心跳；等待进入 GRACE
        time.sleep(2.6)
        self.assertEqual(self.seat()["phase"], "GRACE")
        # 宽限内写被拒（GRACE_WINDOW），但接管也太早
        err, status = req(p, "/api/fence/decide", {
            "seat": "E1", "generation": gen, "actor_id": holder,
            "fingerprint": f"g-{time.time_ns()}",
            "op": "generic_write", "payload": {}}, raw=True)
        self.assertEqual(status, 423)
        self.assertEqual(err["error"], "GRACE_WINDOW")

        # claimant1 发起接管并收集两个见证人
        tk = req(p, "/api/takeovers", {"seat": "E1", "claimant_id": claimant1,
                                       "witness_ids": []})["takeover"]
        req(p, "/api/takeovers/attest", {"takeover_id": tk["id"],
                                         "witness_id": w1})
        # 重复见证拒绝
        err, status = req(p, "/api/takeovers/attest", {
            "takeover_id": tk["id"], "witness_id": w1}, raw=True)
        self.assertEqual(status, 409)
        self.assertEqual(err["error"], "DUPLICATE_WITNESS")
        req(p, "/api/takeovers/attest", {"takeover_id": tk["id"],
                                         "witness_id": w2})
        # 宽限内夺取过早
        err, status = req(p, "/api/takeovers/finalize", {
            "takeover_id": tk["id"], "actor_id": claimant1}, raw=True)
        self.assertEqual(status, 423)
        self.assertIn(err["error"], ("TAKEOVER_PREMATURE", "TAKEOVER_TOO_EARLY"))

        # 竞争者 claimant2 同时发起另一个接管（也凑齐两个见证人）
        tk2 = req(p, "/api/takeovers", {"seat": "E1", "claimant_id": claimant2,
                                        "witness_ids": []})["takeover"]
        req(p, "/api/takeovers/attest", {"takeover_id": tk2["id"],
                                         "witness_id": x1})
        req(p, "/api/takeovers/attest", {"takeover_id": tk2["id"],
                                         "witness_id": x2})
        # 等过失联门槛
        for _ in range(40):
            if self.seat()["phase"] == "EXPIRED":
                break
            time.sleep(0.2)
        self.assertEqual(self.seat()["phase"], "EXPIRED")

        import threading
        results = {}

        def grab(tid, name):
            try:
                results[name] = req(p, "/api/takeovers/finalize",
                                    {"takeover_id": tid, "actor_id": name})
            except Exception as e:  # noqa: BLE001
                results[name] = e

        t = [threading.Thread(target=grab, args=(tk["id"], claimant1)),
             threading.Thread(target=grab, args=(tk2["id"], claimant2))]
        for x in t:
            x.start()
        for x in t:
            x.join()
        winners = [n for n, v in results.items()
                   if not isinstance(v, Exception)]
        losers = [v for n, v in results.items() if isinstance(v, Exception)]
        self.assertEqual(len(winners), 1)
        self.assertEqual(losers[0].code, "TAKEOVER_SUPERSEDED")
        # 只产生一个更大的连续世代
        self.assertEqual(self.seat()["generation"], gen + 1)
        self.assertEqual(self.seat()["holder_id"], winners[0])

        # 旧持有人恢复连接：可读、心跳被拒、写被世代围栏拒绝
        req(p, "/api/state", method="GET")
        err, status = req(p, "/api/seats/heartbeat", {
            "seat": "E1", "actor_id": holder, "generation": gen}, raw=True)
        self.assertEqual(status, 409)
        err, status = req(p, "/api/fence/decide", {
            "seat": "E1", "generation": gen, "actor_id": holder,
            "fingerprint": f"old-{time.time_ns()}",
            "op": "generic_write", "payload": {}}, raw=True)
        self.assertEqual(err["error"], "STALE_GENERATION")

        type(self)._post_takeover_gen = self.seat()["generation"]
        type(self)._post_takeover_holder = self.seat()["holder_id"]
        # 胜者控制台在线，立即以新世代心跳，租约重新起算
        req(p, "/api/seats/heartbeat", {"seat": "E1",
                                        "actor_id": winners[0],
                                        "generation": gen + 1})

    # ------------------------------------------------------------ 重启恢复

    def test_03_restart_recovers_generation_lease_and_verdicts(self):
        p = self.port
        gen_before = self.seat()["generation"]
        holder_before = self.seat()["holder_id"]
        fp = f"persist-{time.time_ns()}"
        # 当前持有人先心跳保活，再做一次写
        req(p, "/api/seats/heartbeat", {"seat": "E1",
                                        "actor_id": holder_before,
                                        "generation": gen_before})
        req(p, "/api/fence/decide", {
            "seat": "E1", "generation": gen_before,
            "actor_id": holder_before, "fingerprint": fp,
            "op": "seal_review", "payload": {"doc": "D-1"}})

        # 打快照 + 再写一条，验证快照与尾部混合恢复
        req(p, "/api/dev/snapshot", {})
        req(p, "/api/seats/heartbeat", {"seat": "E1",
                                        "actor_id": holder_before,
                                        "generation": gen_before})

        # 杀掉进程并重启（真实进程，验证 fsync/重放而非内存对象）
        type(self).proc = type(self).proc.restart()
        p2 = self.port
        self.assertEqual(self.seat()["generation"], gen_before)
        self.assertEqual(self.seat()["holder_id"], holder_before)
        # 指纹判定恢复：相同内容重试拿到 replay
        out = req(p2, "/api/fence/decide", {
            "seat": "E1", "generation": gen_before,
            "actor_id": holder_before, "fingerprint": fp,
            "op": "seal_review", "payload": {"doc": "D-1"}})
        self.assertTrue(out["verdict"]["replay"])
        self.assertEqual(out["verdict"]["response"]["op"], "seal_review")

    def test_05_kill9_mid_life_recovers_no_double_master(self):
        """SIGKILL 崩溃后重启：单调世代、租约边界、请求判定一致；无两个持有人。"""
        p = self.port
        holder = self.seat()["holder_id"]
        gen = self.seat()["generation"]
        req(p, "/api/seats/heartbeat", {"seat": "E1", "actor_id": holder,
                                        "generation": gen})
        fp = f"k9-{time.time_ns()}"
        req(p, "/api/fence/decide", {
            "seat": "E1", "generation": gen, "actor_id": holder,
            "fingerprint": fp, "op": "generic_write",
            "payload": {"k": 9}})
        # 一个待确认交接（只确认、未交出）中途崩溃
        ho = req(p, "/api/handovers", {"seat": "E1", "actor_id": holder,
                                       "successor_id": "grace"})["handover"]
        req(p, "/api/handovers/confirm", {"handover_id": ho["id"],
                                          "actor_id": "grace"})

        type(self).proc = type(self).proc.hard_restart()
        s = self.seat()
        self.assertEqual(s["generation"], gen)
        self.assertEqual(s["holder_id"], holder)  # 唯一持有人仍是旧持有人
        # 原判定回放；世代/持座/租约判断全部恢复
        out = req(p, "/api/fence/decide", {
            "seat": "E1", "generation": gen, "actor_id": holder,
            "fingerprint": fp, "op": "generic_write",
            "payload": {"k": 9}})
        self.assertTrue(out["verdict"]["replay"])
        # 待确认交接恢复为“已确认待交出”，可以继续完成
        done = req(p, "/api/handovers/release", {"handover_id": ho["id"],
                                                 "actor_id": holder})
        self.assertEqual(done["handover"]["status"], "committed")
        self.assertEqual(self.seat()["generation"], gen + 1)
        self.assertEqual(self.seat()["holder_id"], "grace")

    def test_04_witness_qualification_change_blocks_finalize(self):
        p = self.port
        # 资格取消后，原已登记的见证在 finalize 时重算
        holder = self.seat()["holder_id"]
        gen = self.seat()["generation"]
        time.sleep(2.6)  # GRACE
        tk = req(p, "/api/takeovers", {"seat": "E1", "claimant_id": "bob",
                                       "witness_ids": []})["takeover"]
        req(p, "/api/takeovers/attest", {"takeover_id": tk["id"],
                                         "witness_id": "erin"})
        req(p, "/api/takeovers/attest", {"takeover_id": tk["id"],
                                         "witness_id": "frank"})
        req(p, "/api/people/witness-qualified",
            {"actor_id": "zhou", "person_id": "frank", "qualified": False})
        for _ in range(40):
            if self.seat()["phase"] == "EXPIRED":
                break
            time.sleep(0.2)
        err, status = req(p, "/api/takeovers/finalize", {
            "takeover_id": tk["id"], "actor_id": "bob"}, raw=True)
        self.assertEqual(status, 403)
        self.assertEqual(err["error"], "NOT_WITNESS_ELIGIBLE")
        # 补第三人即可
        req(p, "/api/takeovers/attest", {"takeover_id": tk["id"],
                                         "witness_id": "grace"})
        won = req(p, "/api/takeovers/finalize",
                  {"takeover_id": tk["id"], "actor_id": "bob"})
        self.assertEqual(won["takeover"]["status"], "won")
        self.assertEqual(self.seat()["holder_id"], "bob")
        self.assertEqual(self.seat()["generation"], gen + 1)


class AdapterClientTest(unittest.TestCase):
    """校验适配器 + 被保护业务服务的真实 HTTP 集成。"""

    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.mkdtemp(prefix="seatlease-adapter-")
        cls.db = os.path.join(cls.tmpdir, "wal.jsonl")
        cls.port = free_port()
        cls.proc = ServerProc(cls.db, cls.port).start()
        p = cls.port
        req(p, "/api/dev/reset", {})
        for pid, name in [("alice", "Alice"), ("bob", "Bob")]:
            req(p, "/api/people", {"person_id": pid, "name": name})
        req(p, "/api/shifts", {"actor_id": "alice", "name": "X",
                               "seats": []}) if False else None
        # 直接建独立席位并派座（无需班次）
        req(p, "/api/seats/grant", {"seat": "B1", "holder_id": "alice",
                                    "ttl_ms": 60000, "grace_ms": 5000})

        # 启动被保护业务服务
        sys.path.insert(0, EXAMPLES)
        cls.biz_port = free_port()
        env = dict(os.environ)
        env.update({"BIZ_PORT": str(cls.biz_port),
                    "SEATLEASE_URL": f"http://127.0.0.1:{p}",
                    "PYTHONPATH": BACKEND})
        cls.biz_proc = subprocess.Popen(
            [sys.executable, os.path.join(EXAMPLES, "guarded_service.py")],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        deadline = time.time() + 8
        import socket as _sock
        while time.time() < deadline:
            try:
                with _sock.create_connection(("127.0.0.1", cls.biz_port), 0.5):
                    break
            except OSError:
                time.sleep(0.15)

    @classmethod
    def tearDownClass(cls):
        cls.biz_proc.send_signal(signal.SIGINT)
        cls.biz_proc.wait(timeout=5)
        cls.proc.stop()

    def biz(self, path, payload, *, seat, generation, fp, actor):
        r = urllib.request.Request(
            f"http://127.0.0.1:{self.biz_port}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json",
                     "X-Seat": seat, "X-Generation": str(generation),
                     "X-Fingerprint": fp, "X-Actor": actor},
            method="POST")
        try:
            with urllib.request.urlopen(r, timeout=5) as resp:
                return json.loads(resp.read()), resp.status
        except urllib.error.HTTPError as e:
            return json.loads(e.read()), e.code

    def test_adapter_accepts_fences_and_replays(self):
        from adapter import LeaseFence, FenceRejected
        fence = LeaseFence(f"http://127.0.0.1:{self.port}")
        v = fence.decide(seat="B1", generation=1, fingerprint="ad-1",
                         actor_id="alice", op="generic_write",
                         payload={"q": 1})
        self.assertEqual(v["result"], "accepted")
        v2 = fence.decide(seat="B1", generation=1, fingerprint="ad-1",
                          actor_id="alice", op="generic_write",
                          payload={"q": 1})
        self.assertTrue(v2["replay"])
        with self.assertRaises(FenceRejected) as cm:
            fence.decide(seat="B1", generation=1, fingerprint="ad-1",
                         actor_id="alice", op="generic_write",
                         payload={"q": 2})
        self.assertEqual(cm.exception.reason, "FINGERPRINT_REUSE")
        with self.assertRaises(FenceRejected) as cm2:
            fence.decide(seat="B1", generation=99, fingerprint="ad-2",
                         actor_id="alice", op="generic_write", payload={})
        self.assertEqual(cm2.exception.reason, "STALE_GENERATION")

        # 被保护业务服务：合法写 -> applied；旧世代 -> 拒绝且无业务副作用
        body, status = self.biz("/business/convoy-dispatch", {"v": "V1"},
                                seat="B1", generation=1, fp="biz-1",
                                actor="alice")
        self.assertEqual(status, 200)
        self.assertTrue(body["applied"])
        body, status = self.biz("/business/convoy-dispatch", {"v": "V2"},
                                seat="B1", generation=2, fp="biz-2",
                                actor="alice")
        self.assertEqual(status, 409)
        self.assertEqual(body["reason"], "STALE_GENERATION")


if __name__ == "__main__":
    unittest.main(verbosity=2)
