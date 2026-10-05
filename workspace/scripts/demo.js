#!/usr/bin/env node
'use strict';
/**
 * 离线演示脚本：不走 HTTP，直接驱动领域内核，按时间线演示
 *   1) 正常协作交班（确认 + 交出 → 世代 +1，旧控制台被围栏拒绝）
 *   2) 断连与恢复（心跳续租、过期后旧持有人只读不可续租）
 *   3) 竞争紧急接管（双人见证，并发收尾只有一个连续新世代）
 *   4) 指纹幂等与复用冲突
 *
 * 运行：node scripts/demo.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/store');
const { Clock } = require('../src/clock');
const { Coordinator } = require('../src/coordinator');
const { buildBootstrap, applySeed } = require('../src/seed');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-demo-'));
const clock = new Clock(dir);
const c = new Coordinator(new EventStore(dir), clock);
c.init(buildBootstrap());
applySeed(c, 20000);

let step = 0;
function line(t = '') { console.log(t); }
function head(t) { line('\n' + '='.repeat(72) + `\n 场景 ${++step}：${t}\n` + '='.repeat(72)); }
function seat(seatId) {
  const s = c.seats.get(seatId);
  line(`  · ${s.name}: 持有人=${c.users.get(s.currentHolderId).name} 世代=${s.generation} 剩余=${Math.max(0, s.expiresAt - clock.now())}ms`);
}
function pendingHandover(seatId) {
  return [...c.handovers.values()].find((h) => h.seatId === seatId && h.status === 'pending');
}

// ---------------------------------------------------------------- 场景 1：正常交班
head('正常协作交班（撤离方案发布席）');
seat('seat-evac');
line('  周援发起交接 → 苏岚确认 → 周援交出');
c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
const ho1 = pendingHandover('seat-evac');
c.confirmHandover({ handoverId: ho1.id, userId: 'u-su' });
c.releaseHandover({ handoverId: ho1.id, userId: 'u-evac' });
seat('seat-evac');
line('  旧控制台（周援, gen=1）再发写操作：');
let r = c.evaluateRequest({ seatId: 'seat-evac', holderId: 'u-evac', generation: 1, op: 'evacuation', payload: { zones: ['OLD'] }, fingerprint: 'fp-demo-old' });
line(`    -> ${r.decision} / ${r.reason}`);
line('  新主（苏岚, gen=2）写操作：');
r = c.evaluateRequest({ seatId: 'seat-evac', holderId: 'u-su', generation: 2, op: 'evacuation', payload: { zones: ['A-01', 'B-02'] }, fingerprint: 'fp-demo-new' });
line(`    -> ${r.decision} / ${r.verdict.message}`);

// ---------------------------------------------------------------- 场景 2：断连恢复
head('短暂断连与心跳（车队调度席，TTL 20s）');
seat('seat-convoy');
line('  时钟推进 8s（短断连，未到宽限边界），恢复后心跳续租成功：');
clock.setOffset(8000);
r = c.heartbeat({ seatId: 'seat-convoy', holderId: 'u-convoy', generation: 1 });
line(`    -> heartbeat ok, expiresAt 顺延；剩余 ${r.expiresAt - clock.now()}ms`);
line('  此时（t=8s）有人试图对仍有效的封存席紧急接管：');
try { c.openTakeover({ seatId: 'seat-seal', claimantId: 'u-em' }); }
catch (e) { line(`    -> 过早接管被拒：${e.code}`); }
line('  时钟再推进 25s（长时间失联，越过宽限边界）：');
clock.setOffset(8000 + 25000);
seat('seat-convoy');
try {
  c.heartbeat({ seatId: 'seat-convoy', holderId: 'u-convoy', generation: 1 });
} catch (e) {
  line(`    -> 旧持有人续租被拒：${e.code}`);
}
line('    状态仍可查询（只读）：' + (c.snapshot('u-convoy').seats.find((s) => s.id === 'seat-convoy').status === 'expired'));

// ---------------------------------------------------------------- 场景 3：竞争紧急接管
head('竞争紧急接管（车队调度席，需两名合格互异见证人）');
c.openTakeover({ seatId: 'seat-convoy', claimantId: 'u-em' });
c.openTakeover({ seatId: 'seat-convoy', claimantId: 'u-rival' });
const tkEm = [...c.takeovers.values()].find((t) => t.claimantId === 'u-em' && t.status === 'open');
const tkRival = [...c.takeovers.values()].find((t) => t.claimantId === 'u-rival' && t.status === 'open');
line('  应急值班员 与 竞争值班员 各自收到见证人甲签名；');
c.attestTakeover({ takeoverId: tkEm.id, witnessId: 'u-w1' });
c.attestTakeover({ takeoverId: tkRival.id, witnessId: 'u-w1' });
line('  双方几乎同时收到见证人乙签名（并发收尾）：');
c.attestTakeover({ takeoverId: tkEm.id, witnessId: 'u-w2' });
try {
  c.attestTakeover({ takeoverId: tkRival.id, witnessId: 'u-w2' });
} catch (e) {
  line(`    -> 竞争者收尾被 CAS 拒绝：${e.code}`);
}
seat('seat-convoy');

// ---------------------------------------------------------------- 场景 4：指纹（趁接管后的新租约有效）
head('请求指纹：幂等重试与复用冲突（新主 u-em / gen 2）');
const fp = 'fp-demo-idem';
const payload = { vehicleCount: 9 };
r = c.evaluateRequest({ seatId: 'seat-convoy', holderId: 'u-em', generation: 2, op: 'convoy', payload, fingerprint: fp });
line(`  首次: ${r.decision} / ${r.verdict.code}`);
r = c.evaluateRequest({ seatId: 'seat-convoy', holderId: 'u-em', generation: 2, op: 'convoy', payload, fingerprint: fp });
line(`  完全相同重试: ${r.decision} / ${r.reason}`);
r = c.evaluateRequest({ seatId: 'seat-convoy', holderId: 'u-em', generation: 2, op: 'convoy', payload: { vehicleCount: 10 }, fingerprint: fp });
line(`  同指纹不同载荷: ${r.decision} / ${r.reason}`);
r = c.evaluateRequest({ seatId: 'seat-convoy', holderId: 'u-rival', generation: 2, op: 'convoy', payload, fingerprint: 'fp-demo-impostor' });
line(`  非持有人写操作: ${r.decision} / ${r.reason}`);
r = c.evaluateRequest({ seatId: 'seat-convoy', holderId: 'u-convoy', generation: 1, op: 'convoy', payload, fingerprint: 'fp-demo-stale' });
line(`  旧主旧世代写操作: ${r.decision} / ${r.reason}`);

// ---------------------------------------------------------------- 场景 5：见证规则（其余失败路径）
head('见证规则：申请人自证 / 无资格 / 重复见证 / 夺取后补签');
// 封存席同样在 t=20s 过期，可直接演示见证约束（过早接管已在场景 2 演示）
c.openTakeover({ seatId: 'seat-seal', claimantId: 'u-em' });
const tkBad = [...c.takeovers.values()].find((t) => t.claimantId === 'u-em' && t.status === 'open' && t.seatId === 'seat-seal');
for (const [label, fn] of [
  ['申请人自任见证人', () => c.attestTakeover({ takeoverId: tkBad.id, witnessId: 'u-em' })],
  ['无资格见证人（关证）', () => c.attestTakeover({ takeoverId: tkBad.id, witnessId: 'u-w3' })],
  ['合格见证人甲（第一次，有效）', () => c.attestTakeover({ takeoverId: tkBad.id, witnessId: 'u-w1' })],
  ['见证人甲重复签名', () => c.attestTakeover({ takeoverId: tkBad.id, witnessId: 'u-w1' })],
  ['合格见证人乙（第二次，夺取成功）', () => c.attestTakeover({ takeoverId: tkBad.id, witnessId: 'u-w2' })],
  ['夺取后再补签名（不能改变归属）', () => c.attestTakeover({ takeoverId: tkBad.id, witnessId: 'u-w3' })],
]) {
  try { const x = fn(); line(`    -> ${label}: 接受（当前 ${x.takeovers.find((t) => t.id === tkBad.id).witnesses.length} 名见证）`); }
  catch (e) { line(`    -> ${label}: 拒绝 ${e.code}`); }
}
seat('seat-seal');


line('\n演示数据目录（可删除）: ' + dir);
process.exit(0);
