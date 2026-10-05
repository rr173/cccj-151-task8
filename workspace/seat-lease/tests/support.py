"""测试公共夹具：假钟 + 临时 WAL。"""
import os
import sys
import tempfile
import shutil

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "backend"))

from coordinator import Coordinator  # noqa: E402
from store import Store  # noqa: E402


class FakeClock:
    """毫秒假钟，默认从一个固定时刻开始，可前进/读取。"""

    def __init__(self, start: float = 1_700_000_000_000.0):
        self.t = start

    def now_ms(self) -> float:
        return self.t

    def advance(self, ms: float) -> float:
        self.t += ms
        return self.t


class Harness:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="seatlease-test-")
        self.clock = FakeClock()
        self.path = os.path.join(self.dir, "wal.jsonl")
        self.coord = self.new_coord()

    def new_coord(self) -> Coordinator:
        store = Store(self.path)
        return Coordinator(store, now_ms=self.clock.now_ms)

    def reopen(self) -> Coordinator:
        """模拟进程重启：新建 Store + Coordinator，从 WAL/快照恢复。"""
        self.coord.store.close()
        self.coord = self.new_coord()
        return self.coord

    def cleanup(self):
        try:
            self.coord.store.close()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(self.dir, ignore_errors=True)


def build_world(h: Harness) -> Coordinator:
    """一个标准世界：zhou 排班；三席位；alice/carol/erin 持座。"""
    c = h.coord
    c.register_person("zhou", "周班", ["shift_lead"])
    for pid, name, wq in [
        ("alice", "Alice", True), ("bob", "Bob", True),
        ("carol", "Carol", True), ("dave", "Dave", False),
        ("erin", "Erin", True), ("frank", "Frank", True),
        ("grace", "Grace", True),
    ]:
        c.register_person(pid, name, [], wq)
    c.create_shift("zhou", "测试日班", [
        {"id": "S1", "ttl_ms": 1000, "grace_ms": 500},
        {"id": "S2", "ttl_ms": 1000, "grace_ms": 500},
    ])
    c.grant_seat("S1", "alice")
    c.grant_seat("S2", "carol")
    return c
