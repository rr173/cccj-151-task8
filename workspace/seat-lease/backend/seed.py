"""演示数据：一个班次、三个席位（撤离指挥 / 车队调度 / 封存审查），
若干候选接班人与见证人。租约参数刻意设短，方便页面上直接演示断连与接管。"""
from __future__ import annotations

from coordinator import Coordinator


def seed(c: Coordinator) -> None:
    people = [
        # id, 姓名, 角色, 见证资格
        ("zhou", "周班（排班负责人）", ["shift_lead"], False),
        ("alice", "艾丽（撤离指挥 A 班）", ["operator"], True),
        ("bob", "鲍博（撤离指挥接班人）", ["operator"], True),
        ("carol", "卡罗（车队调度）", ["operator"], True),
        ("dave", "戴夫（车队接班人）", ["operator"], False),
        ("erin", "叶琳（封存审查）", ["operator"], True),
        ("frank", "方克（封存接班人）", ["operator"], True),
        ("grace", "格雷（后备见证人）", ["observer"], True),
    ]
    for pid, name, roles, wq in people:
        c.register_person(pid, name, roles, wq)

    shift = c.create_shift("zhou", "2026-10-05 日班", [
        {"id": "EVAC-1", "ttl_ms": 15_000, "grace_ms": 8_000},
        {"id": "CONVOY-1", "ttl_ms": 15_000, "grace_ms": 8_000},
        {"id": "SEAL-1", "ttl_ms": 20_000, "grace_ms": 10_000},
    ])

    c.grant_seat("EVAC-1", "alice")
    c.grant_seat("CONVOY-1", "carol")
    c.grant_seat("SEAL-1", "erin")
    return shift
