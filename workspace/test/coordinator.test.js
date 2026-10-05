'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventStore } = require('../src/store');
const { Clock } = require('../src/clock');
const { Coordinator } = require('../src/coordinator');
const { buildBootstrap, applySeed } = require('../src/seed');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duty-seat-'));
}
function makeCoordinator(dir, { ttlMs = 20000, seed = true } = {}) {
  const store = new EventStore(dir);
  const clock = new Clock(dir);
  const c = new Coordinator(store, clock);
  c.init(buildBootstrap());
  if (seed && c.shifts.size === 0) applySeed(c, ttlMs);
  return { c, store, clock };
}
function fresh(opts) {
  const dir = tmpDir();
  const kit = makeCoordinator(dir, opts);
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ...kit };
}
function throwsCode(code) { return (e) => e && e.code === code; }
function request(c, overrides = {}) {
  return c.evaluateRequest({
    seatId: 'seat-evac', holderId: 'u-evac', generation: 1,
    op: 'evacuation', payload: { zones: ['A'] }, fingerprint: 'fp-' + Math.random().toString(36).slice(2),
    ...overrides,
  });
}

// ---------------------------------------------------------------- 围栏与幂等

test('当前持有人当前世代的业务请求被接受，结果持久化', () => {
  const { c } = fresh();
  const r = request(c);
  assert.equal(r.decision, 'ACCEPT');
  assert.equal(r.verdict.ok, true);
});

test('完全相同的重试（相同指纹+相同内容）返回原判定，即使已交班', () => {
  const { c } = fresh();
  const fp = 'fp-fixed-1';
  const payload = { zones: ['A-01'] };
  const first = request(c, { fingerprint: fp, payload });
  assert.equal(first.decision, 'ACCEPT');

  // 完成交班到 u-su：世代变为 2
  c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
  const ho = c.snapshot().handovers.find((h) => h.seatId === 'seat-evac' && h.status === 'pending');
  c.confirmHandover({ handoverId: ho.id, userId: 'u-su' });
  c.releaseHandover({ handoverId: ho.id, userId: 'u-evac' });
  assert.equal(c.seats.get('seat-evac').generation, 2);

  // 旧控制台完全相同的重试 —— 原判定仍可查（幂等），不回滚
  const replay = request(c, { fingerprint: fp, payload });
  assert.equal(replay.decision, 'ACCEPT_REPLAY');
  assert.deepEqual(replay.verdict, first.verdict);
});

test('复用指纹但载荷不同 -> FINGERPRINT_REUSED 拒绝', () => {
  const { c } = fresh();
  const fp = 'fp-reuse';
  assert.equal(request(c, { fingerprint: fp, payload: { zones: ['A'] } }).decision, 'ACCEPT');
  const d = request(c, { fingerprint: fp, payload: { zones: ['B'] } });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.reason, 'FINGERPRINT_REUSED');
});

test('复用指纹但席位/世代/操作不同同样拒绝', () => {
  const { c } = fresh();
  const fp = 'fp-cross';
  assert.equal(request(c, { fingerprint: fp }).decision, 'ACCEPT');
  assert.equal(request(c, { fingerprint: fp, seatId: 'seat-convoy' }).reason, 'FINGERPRINT_REUSED');
  assert.equal(request(c, { fingerprint: fp, op: 'sealing' }).reason, 'FINGERPRINT_REUSED');
  assert.equal(request(c, { fingerprint: fp, generation: 9 }).reason, 'FINGERPRINT_REUSED');
});

test('交班后旧世代旧持有人的新写操作被围栏拒绝（无双主）', () => {
  const { c } = fresh();
  c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
  const ho = c.snapshot().handovers.find((h) => h.seatId === 'seat-evac' && h.status === 'pending');
  c.confirmHandover({ handoverId: ho.id, userId: 'u-su' });
  c.releaseHandover({ handoverId: ho.id, userId: 'u-evac' });

  const oldConsole = request(c, { fingerprint: 'fp-old-gen', generation: 1 });
  assert.equal(oldConsole.decision, 'DENY');
  assert.equal(oldConsole.reason, 'STALE_GENERATION');

  // 非持有人冒充
  assert.equal(request(c, { fingerprint: 'fp-impostor', holderId: 'u-rival', generation: 2 }).reason, 'NOT_HOLDER');
  // 新主可以写
  assert.equal(request(c, { fingerprint: 'fp-new', holderId: 'u-su', generation: 2 }).decision, 'ACCEPT');
});

test('席位类型不匹配的操作被拒', () => {
  const { c } = fresh();
  assert.equal(request(c, { fingerprint: 'fp-kind', op: 'convoy' }).reason, 'KIND_MISMATCH');
});

test('payloadHash 不一致（篡改）被拒', () => {
  const { c } = fresh();
  assert.throws(() => request(c, { payloadHash: 'deadbeef' }), (e) => e.code === 'PAYLOAD_HASH_MISMATCH');
});

test('业务失败也是原判定：相同重试返回业务失败结果', () => {
  const { c } = fresh();
  const fp = 'fp-bizfail';
  const first = request(c, { fingerprint: fp, payload: { zones: [] } });
  assert.equal(first.decision, 'ACCEPT');
  assert.equal(first.verdict.ok, false);
  const again = request(c, { fingerprint: fp, payload: { zones: [] } });
  assert.equal(again.decision, 'ACCEPT_REPLAY');
  assert.equal(again.verdict.ok, false);
});

// ---------------------------------------------------------------- 交班状态机

test('交班：仅确认未交出 / 仅交出未确认，世代都不变；两步齐备才 +1', () => {
  const { c } = fresh();
  c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
  const hoId = c.seats.get('seat-evac').handoverId;
  const genBefore = c.seats.get('seat-evac').generation;

  c.confirmHandover({ handoverId: hoId, userId: 'u-su' });
  assert.equal(c.seats.get('seat-evac').generation, genBefore);
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-evac');

  // 逆序：另一流程交出 + 确认
  c.startHandover({ seatId: 'seat-convoy', actorId: 'u-convoy', toUserId: 'u-he' });
  const ho2 = c.seats.get('seat-convoy').handoverId;
  c.releaseHandover({ handoverId: ho2, userId: 'u-convoy' });
  assert.equal(c.seats.get('seat-convoy').currentHolderId, 'u-convoy'); // 尚未生效
  c.confirmHandover({ handoverId: ho2, userId: 'u-he' });
  assert.equal(c.seats.get('seat-convoy').currentHolderId, 'u-he');
  assert.equal(c.seats.get('seat-convoy').generation, 2);

  // 回到第一个：交出后生效
  c.releaseHandover({ handoverId: hoId, userId: 'u-evac' });
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-su');
  assert.equal(c.seats.get('seat-evac').generation, 2);
});

test('已交出但未完成确认期间，旧持有人写操作与续租都被拒', () => {
  const { c } = fresh();
  c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
  const hoId = c.seats.get('seat-evac').handoverId;
  c.releaseHandover({ handoverId: hoId, userId: 'u-evac' });
  assert.equal(request(c, { fingerprint: 'fp-sur' }).reason, 'SURRENDERED');
  assert.throws(() => c.heartbeat({ seatId: 'seat-evac', holderId: 'u-evac', generation: 1 }), throwsCode("SURRENDERED"));
});

test('非指定接班人不能确认；取消后流程作废且恢复可写', () => {
  const { c } = fresh();
  c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
  const hoId = c.seats.get('seat-evac').handoverId;
  assert.throws(() => c.confirmHandover({ handoverId: hoId, userId: 'u-he' }), throwsCode("NOT_CANDIDATE"));
  c.cancelHandover({ handoverId: hoId, userId: 'u-evac', reason: 'test' });
  assert.equal(c.seats.get('seat-evac').handoverId, null);
  assert.equal(request(c, { fingerprint: 'fp-after-cancel' }).decision, 'ACCEPT');
  // 作废流程不能继续
  assert.throws(() => c.confirmHandover({ handoverId: hoId, userId: 'u-su' }), throwsCode("HANDOVER_NOT_PENDING"));
});

test('确认与交出接口幂等：重复调用不产生多个世代', () => {
  const { c } = fresh();
  c.startHandover({ seatId: 'seat-evac', actorId: 'u-evac', toUserId: 'u-su' });
  const hoId = c.seats.get('seat-evac').handoverId;
  c.confirmHandover({ handoverId: hoId, userId: 'u-su' });
  c.confirmHandover({ handoverId: hoId, userId: 'u-su' });
  c.releaseHandover({ handoverId: hoId, userId: 'u-evac' });
  c.releaseHandover({ handoverId: hoId, userId: 'u-evac' });
  assert.equal(c.seats.get('seat-evac').generation, 2);
});

// ---------------------------------------------------------------- 心跳 / 租约 / 时钟

test('租约未到期不能接管；过期后旧持有人不能续租，但可读状态', () => {
  const { c, clock } = fresh();
  // 非持有人提前申请
  assert.throws(() => c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em', expectedGeneration: 1 }), throwsCode("LEASE_ACTIVE"));
  // 快进越过宽限边界
  clock.setOffset(25000);
  assert.equal(c.seatView(c.seats.get('seat-evac')).status, 'expired');
  assert.throws(() => c.heartbeat({ seatId: 'seat-evac', holderId: 'u-evac', generation: 1 }), throwsCode("LEASE_EXPIRED"));
  // 状态仍可查
  assert.ok(c.snapshot('u-evac').seats.find((s) => s.id === 'seat-evac'));
});

test('心跳续租延长宽限边界，过期前另一人无法取得席位', () => {
  const { c, clock } = fresh({ ttlMs: 1000 });
  clock.setOffset(800);
  const r = c.heartbeat({ seatId: 'seat-evac', holderId: 'u-evac', generation: 1 });
  assert.ok(r.expiresAt > clock.now());
  clock.setOffset(1500); // 原始 TTL 早该过期，但续租过所以仍有效
  assert.equal(c.seatView(c.seats.get('seat-evac')).status, 'held');
  assert.throws(() => c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' }), throwsCode("LEASE_ACTIVE"));
});

test('旧世代请求不能续租（STALE_GENERATION）', () => {
  const { c } = fresh();
  assert.throws(() => c.heartbeat({ seatId: 'seat-evac', holderId: 'u-evac', generation: 5 }), throwsCode("STALE_GENERATION"));
});

// ---------------------------------------------------------------- 紧急接管

function expireSeat(c, clock, seatId = 'seat-evac') {
  clock.setOffset(c.seats.get(seatId).ttlMs + 100);
}

test('紧急接管：两名合格且互不相同见证人后夺取，世代连续 +1', () => {
  const { c, clock } = fresh();
  expireSeat(c, clock);
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em', expectedGeneration: 1 });
  const tk = c.snapshot().takeovers.find((t) => t.status === 'open' && t.seatId === 'seat-evac');
  c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w1' });
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-evac'); // 一人不够
  c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w2' });
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-em');
  assert.equal(c.seats.get('seat-evac').generation, 2);
});

test('重复见证无效：同一见证人不能当两人', () => {
  const { c, clock } = fresh();
  expireSeat(c, clock);
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' });
  const tk = c.snapshot().takeovers.find((t) => t.status === 'open');
  c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w1' });
  assert.throws(() => c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w1' }), throwsCode("DUPLICATE_WITNESS"));
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-evac');
});

test('无资格见证被拒；资格在夺取前被撤销也无法夺取', () => {
  const { c, clock } = fresh();
  expireSeat(c, clock);
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' });
  const tk = c.snapshot().takeovers.find((t) => t.status === 'open');
  assert.throws(() => c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w3' }), throwsCode("WITNESS_UNQUALIFIED"));
  c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w1' });
  // 撤销 w2 的资格
  c.setWitnessQualified({ actorId: 'u-lead', userId: 'u-w2', qualified: false });
  assert.throws(() => c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w2' }), throwsCode("WITNESS_UNQUALIFIED"));
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-evac');
  // u-w3 自始至终无资格
  assert.throws(() => c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w3' }), throwsCode("WITNESS_UNQUALIFIED"));
  // 恢复 w2 资格后才能凑齐两名
  c.setWitnessQualified({ actorId: 'u-lead', userId: 'u-w2', qualified: true });
  c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w2' });
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-em');
  assert.equal(c.seats.get('seat-evac').generation, 2);
});

test('申请人不能自任见证人', () => {
  const { c, clock } = fresh();
  expireSeat(c, clock);
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' });
  const tk = c.snapshot().takeovers.find((t) => t.status === 'open');
  assert.throws(() => c.attestTakeover({ takeoverId: tk.id, witnessId: 'u-em' }), throwsCode("WITNESS_CONFLICT"));
});

test('过早接管：失联未达门槛，见证被拒', () => {
  const { c } = fresh(); // 租约仍有效
  // 开放申请本身就会被拒
  assert.throws(() => c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' }), throwsCode("LEASE_ACTIVE"));
});

test('基于旧世代的接管请求被拒；归属确定后见证不能改变结果', () => {
  const { c, clock } = fresh();
  expireSeat(c, clock);
  // u-em 成功接管
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em', expectedGeneration: 1 });
  const tk1 = c.snapshot().takeovers.find((t) => t.status === 'open');
  c.attestTakeover({ takeoverId: tk1.id, witnessId: 'u-w1' });
  c.attestTakeover({ takeoverId: tk1.id, witnessId: 'u-w2' });
  assert.equal(c.seats.get('seat-evac').generation, 2);

  // 基于旧世代的申请
  assert.throws(() => c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-rival', expectedGeneration: 1 }), throwsCode("STALE_GENERATION"));
  // 旧申请再见证无效
  assert.throws(() => c.attestTakeover({ takeoverId: tk1.id, witnessId: 'u-w1' }), throwsCode("SUPERSEDED"));
});

test('并发竞争者同时接管：两份申请各自收证，但只有一个 CAS 胜者取得连续新世代', () => {
  const { c, clock } = fresh();
  expireSeat(c, clock);
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' });
  c.openTakeover({ seatId: 'seat-evac', claimantId: 'u-rival' });
  const snaps = c.snapshot().takeovers;
  const tkEm = snaps.find((t) => t.claimantId === 'u-em' && t.status === 'open');
  const tkRival = snaps.find((t) => t.claimantId === 'u-rival' && t.status === 'open');
  assert.ok(tkEm && tkRival);
  assert.notEqual(tkEm.id, tkRival.id);

  // 双方都凑齐两名见证人（同步单线程下模拟交错提交：先备齐证据点，再看 CAS）
  c.attestTakeover({ takeoverId: tkEm.id, witnessId: 'u-w1' });
  c.attestTakeover({ takeoverId: tkRival.id, witnessId: 'u-w1' });
  c.attestTakeover({ takeoverId: tkEm.id, witnessId: 'u-w2' }); // 此提交原子夺取成功
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-em');
  assert.equal(c.seats.get('seat-evac').generation, 2);

  // 竞争者最后一证到达：申请已被新世代超越，拒绝且不改变归属
  assert.throws(() => c.attestTakeover({ takeoverId: tkRival.id, witnessId: 'u-w2' }), throwsCode("SUPERSEDED"));
  assert.equal(c.seats.get('seat-evac').currentHolderId, 'u-em');
  assert.equal(c.seats.get('seat-evac').generation, 2);
});

// ---------------------------------------------------------------- 崩溃恢复

test('崩溃恢复：重放日志恢复用户、班次、世代、租约边界与请求判定', () => {
  const dir = tmpDir();
  const kit1 = makeCoordinator(dir);
  const c1 = kit1.c;
  c1.heartbeat({ seatId: 'seat-evac', holderId: 'u-evac', generation: 1 });
  request(c1, { fingerprint: 'fp-durable', payload: { zones: ['D'] } });
  c1.startHandover({ seatId: 'seat-convoy', actorId: 'u-convoy', toUserId: 'u-he' });
  const ho = c1.snapshot().handovers.find((h) => h.seatId === 'seat-convoy');
  c1.confirmHandover({ handoverId: ho.id, userId: 'u-he' });
  const convoyExpiresBefore = c1.seats.get('seat-convoy').expiresAt;

  // 新进程视角重建
  const kit2 = makeCoordinator(dir);
  const c2 = kit2.c;
  // 已有 bootstrap/班次，createShift 不会重复建
  assert.equal(c2.shifts.size, 1);
  assert.equal(c2.seats.size, 3);
  // 交接只确认未交出：恢复后仍 pending，持有者不变、世代不变
  const convoy = c2.seats.get('seat-convoy');
  assert.equal(convoy.currentHolderId, 'u-convoy');
  assert.equal(convoy.generation, 1);
  assert.equal(c2.seats.get('seat-evac').expiresAt > 0, true);
  // 已接受判定恢复：相同指纹返回原判定
  const replay = request(c2, { fingerprint: 'fp-durable', payload: { zones: ['D'] } });
  assert.equal(replay.decision, 'ACCEPT_REPLAY');
  // 继续完成交接，世代推进到 2
  const ho2 = c2.snapshot().handovers.find((h) => h.seatId === 'seat-convoy' && h.status === 'pending');
  c2.releaseHandover({ handoverId: ho2.id, userId: 'u-convoy' });
  assert.equal(c2.seats.get('seat-convoy').currentHolderId, 'u-he');
  assert.equal(c2.seats.get('seat-convoy').generation, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('演示时钟快进持久化：崩溃重启后偏移仍在，不能靠重启使租约复活', () => {
  const dir = tmpDir();
  const clock1 = new Clock(dir);
  const c1 = new Coordinator(new EventStore(dir), clock1);
  c1.init(buildBootstrap());
  applySeed(c1, 20000);
  // 班次运行一段时间后失联：快进时钟使租约越过宽限边界
  clock1.setOffset(25000);
  assert.equal(c1.seatView(c1.seats.get('seat-evac')).status, 'expired');
  assert.equal(new Clock(dir).offsetMs, 25000);
  // 紧急接管后新持有人拿到全新 20s 租约
  c1.openTakeover({ seatId: 'seat-evac', claimantId: 'u-em' });
  const tk = c1.snapshot().takeovers.find((t) => t.status === 'open');
  c1.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w1' });
  c1.attestTakeover({ takeoverId: tk.id, witnessId: 'u-w2' });
  assert.equal(c1.seats.get('seat-evac').generation, 2);

  // “崩溃重启”：新 Clock 从磁盘读回偏移
  const c2 = new Coordinator(new EventStore(dir), new Clock(dir));
  c2.init(buildBootstrap()); // 不再 seed
  assert.equal(c2.shifts.size, 1);
  // 世代恢复为 2，旧持有人的 gen1 心跳被世代围栏挡住，绝不能续租
  assert.throws(
    () => c2.heartbeat({ seatId: 'seat-evac', holderId: 'u-evac', generation: 1 }),
    (e) => e.code === 'STALE_GENERATION' || e.code === 'LEASE_EXPIRED'
  );

  // 再快进到新租约也过期，重放得到的边界一致：过期状态不会因重启改变
  new Clock(dir).setOffset(50000);
  const c3 = new Coordinator(new EventStore(dir), new Clock(dir));
  c3.init(buildBootstrap());
  assert.equal(c3.seatView(c3.seats.get('seat-evac')).status, 'expired');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('事件日志尾部半行在重启时被修复，不会导致无法判定', () => {
  const dir = tmpDir();
  const kit = makeCoordinator(dir);
  request(kit.c, { fingerprint: 'fp-tail' });
  const log = require('node:fs').readFileSync(kit.store.logPath, 'utf8');
  const lines = log.trim().split('\n');
  const good = lines.slice(0, -1).join('\n') + '\n';
  const partial = lines[lines.length - 1].slice(0, 20); // 模拟只写了半行就掉电
  require('node:fs').writeFileSync(kit.store.logPath, good + partial);

  const store2 = new EventStore(dir); // 构造时修复
  const c2 = new Coordinator(store2, new Clock());
  c2.init(buildBootstrap());
  assert.equal(c2.shifts.size, 1);
  // 半行请求丢失：指纹尚未被接受，可重试
  assert.equal(request(c2, { fingerprint: 'fp-tail' }).decision, 'ACCEPT');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重置后可干净引导', () => {
  const { c } = fresh();
  request(c, { fingerprint: 'fp-x' });
  c.resetAndBootstrap(buildBootstrap());
  applySeed(c, 20000);
  assert.equal(c.lastSeq > 0, true);
  assert.equal(c.seats.get('seat-evac').generation, 1);
  assert.equal(c.verdicts.size, 0);
});
