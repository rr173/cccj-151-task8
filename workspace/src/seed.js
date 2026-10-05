'use strict';

/**
 * 演示数据：一个夜班、三类席位（撤离方案发布 / 车队调度 / 封存审查），
 * 初始持有人世代均为 1，另配候选接班人、合格/不合格见证人与排班负责人。
 */
const DEMO_USERS = [
  { id: 'u-lead',   name: '林班（排班负责人）', role: 'lead',    witnessQualified: false },
  { id: 'u-evac',   name: '周援（撤离席主值）', role: 'operator', witnessQualified: false },
  { id: 'u-convoy', name: '陈行（车队席主值）', role: 'operator', witnessQualified: false },
  { id: 'u-seal',   name: '方检（封存席主值）', role: 'operator', witnessQualified: false },
  { id: 'u-su',     name: '苏岚（候选接班人）', role: 'operator', witnessQualified: false },
  { id: 'u-he',     name: '何跃（候选接班人）', role: 'operator', witnessQualified: false },
  { id: 'u-w1',     name: '雷证（见证人甲）',   role: 'witness', witnessQualified: true },
  { id: 'u-w2',     name: '贺证（见证人乙）',   role: 'witness', witnessQualified: true },
  { id: 'u-w3',     name: '关证（资格待审）',   role: 'witness', witnessQualified: false },
  { id: 'u-em',     name: '应急值班员',         role: 'operator', witnessQualified: false },
  { id: 'u-rival',  name: '竞争值班员',         role: 'operator', witnessQualified: false },
];

function buildBootstrap() {
  return {
    name: '值班席位租约协调器演示',
    lease: { defaultTtlMs: 20000, heartbeatMs: 7000, emergencyWitnesses: 2 },
    users: DEMO_USERS,
  };
}

function applySeed(coordinator, ttlMs = 20000) {
  coordinator.createShift({
    actorId: 'u-lead',
    name: '2026-10-05 夜班',
    seats: [
      { id: 'seat-evac',   name: '撤离方案发布席', kind: 'evacuation', holderId: 'u-evac',   ttlMs },
      { id: 'seat-convoy', name: '车队调度席',     kind: 'convoy',     holderId: 'u-convoy', ttlMs },
      { id: 'seat-seal',   name: '封存审查席',     kind: 'sealing',    holderId: 'u-seal',   ttlMs },
    ],
  });
}

module.exports = { buildBootstrap, applySeed, DEMO_USERS };
