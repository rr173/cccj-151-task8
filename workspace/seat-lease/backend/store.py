"""值班席位租约协调器 —— 持久化层（仅 Python 标准库）。

崩溃安全模型
============
所有状态变更都是**追加一条 WAL 事件**：在全局锁内
``write -> flush -> fsync``，落盘成功后才更新内存态并返回客户端。
因此提交点就是 fsync：

* 崩在 fsync 之前：事件不存在，重启后状态停留在上一个已提交动作
  （例如交接停在“接班人已确认、待持有人交出”，绝不会出现两个持有人，
   也不会无人可判定——原持有人仍然有效）。
* 崩在 fsync 之后：事件随重放恢复，世代号与租约边界单调延续。

事件为一行一个 JSON（JSONL）。状态积累过多时可做快照压缩：
快照（state@seq=N，tmp+fsync+原子 rename）先落盘，再把日志重写为
``seq>N`` 的尾部（tmp+fsync+rename）。任意时刻崩溃：

* 快照已有、旧日志还在 -> 重放时按 seq 跳过 <=N 的事件；
* 日志已压缩 -> 快照 + 尾部恰好复原全部状态。
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable

_ENCODING = "utf-8"


class Store:
    """JSONL WAL + 快照。所有公开方法都在同一把 ``lock`` 内串行。"""

    def __init__(self, path: str):
        self.path = path
        self.snapshot_path = path + ".snapshot"
        self.lock = threading.RLock()
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._fh = open(path, "a", encoding=_ENCODING)
        self.last_seq = 0

    # ------------------------------------------------------------- 恢复

    def recover(
        self,
        initial_state: dict[str, Any],
        reduce_fn: Callable[[dict[str, Any], dict[str, Any]], None],
    ) -> dict[str, Any]:
        """按 快照 + WAL 重放，返回还原后的状态。``reduce_fn`` 原地改写 state。"""
        with self.lock:
            state = initial_state
            seq = 0
            if os.path.exists(self.snapshot_path):
                with open(self.snapshot_path, "r", encoding=_ENCODING) as f:
                    snap = json.load(f)
                state = snap["state"]
                seq = snap["seq"]
            if os.path.exists(self.path):
                with open(self.path, "r", encoding=_ENCODING) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        entry = json.loads(line)
                        if entry["seq"] <= seq:
                            continue
                        reduce_fn(state, entry)
                        seq = entry["seq"]
            self.last_seq = seq
            return state

    def read_events(self, limit: int = 200) -> list[dict[str, Any]]:
        with self.lock:
            self._fh.flush()
            entries: list[dict[str, Any]] = []
            if os.path.exists(self.path):
                with open(self.path, "r", encoding=_ENCODING) as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            entries.append(json.loads(line))
            return entries[-limit:]

    # ------------------------------------------------------------- 追加

    def append(self, event_type: str, data: dict[str, Any], ts: float) -> dict[str, Any]:
        """调用方必须持有协调器提交锁（与快照/恢复互斥）。"""
        self.last_seq += 1
        entry = {"seq": self.last_seq, "ts": ts, "type": event_type, "data": data}
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n"
        self._fh.write(line)
        self._fh.flush()
        os.fsync(self._fh.fileno())
        return entry

    # ------------------------------------------------------------- 快照

    def snapshot(self, state: dict[str, Any], seq: int) -> None:
        """在 seq 处打快照并重写日志，只保留 seq>N 的尾部。调用方持提交锁。"""
        with self.lock:
            tail: list[str] = []
            if os.path.exists(self.path):
                with open(self.path, "r", encoding=_ENCODING) as f:
                    for line in f:
                        stripped = line.strip()
                        if stripped and json.loads(stripped)["seq"] > seq:
                            tail.append(stripped + "\n")

            # 1) 快照先落盘（tmp -> fsync -> rename -> fsync 目录）
            tmp_snap = self.snapshot_path + ".tmp"
            with open(tmp_snap, "w", encoding=_ENCODING) as f:
                json.dump({"seq": seq, "state": state}, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_snap, self.snapshot_path)
            _fsync_dir(os.path.dirname(os.path.abspath(self.path)))

            # 2) 再压缩日志（tmp -> fsync -> rename），崩溃在两步之间也可恢复
            tmp_log = self.path + ".tmp"
            with open(tmp_log, "w", encoding=_ENCODING) as f:
                f.writelines(tail)
                f.flush()
                os.fsync(f.fileno())
            self._fh.close()
            os.replace(tmp_log, self.path)
            _fsync_dir(os.path.dirname(os.path.abspath(self.path)))
            self._fh = open(self.path, "a", encoding=_ENCODING)

    def reset(self) -> None:
        with self.lock:
            self._close_fh()
            for p in (self.path, self.snapshot_path,
                      self.path + ".tmp", self.snapshot_path + ".tmp"):
                try:
                    os.remove(p)
                except FileNotFoundError:
                    pass
            self._fh = open(self.path, "a", encoding=_ENCODING)
            self.last_seq = 0

    def close(self) -> None:
        with self.lock:
            self._close_fh()

    def _close_fh(self) -> None:
        try:
            self._fh.close()
        except Exception:  # noqa: BLE001
            pass


def _fsync_dir(dir_path: str) -> None:
    try:
        fd = os.open(dir_path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        # 某些文件系统不支持目录 fsync，不影响正确性（rename 本身原子）
        pass
