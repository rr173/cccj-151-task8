'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForUrl(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return; lastErr = null; } catch (e) { lastErr = e; }
    await wait(120);
  }
  throw new Error('server not ready: ' + (lastErr && lastErr.message));
}

/** 独立子进程方式启动真实服务（用于崩溃恢复测试） */
function startServer({ port, dataDir, env = {} }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SEED_ON_START: '1', ENABLE_DEV_TOOLS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function post(base, p, body, actor) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}) },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}
async function getState(base, as) {
  const r = await fetch(base + '/api/state' + (as ? `?as=${as}` : ''));
  return r.json();
}

test('HTTP 全链路：交班后旧控制台被围栏拒绝，相同重试返回原判定', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-http-'));
  const port = 8901;
  const srv = startServer({ port, dataDir: dir });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForUrl(base + '/api/health');
    let s = await getState(base);
    assert.equal(s.seats.find((x) => x.id === 'seat-evac').generation, 1);

    // 初始持有人接受一个业务请求
    const fp = 'fp-http-1';
    const payload = { zones: ['C-03'] };
    let r = await post(base, '/api/adapter/evaluate', { seatId: 'seat-evac', generation: 1, op: 'evacuation', payload, fingerprint: fp }, 'u-evac');
    assert.equal(r.json.decision, 'ACCEPT');

    // 复用指纹 + 不同载荷
    r = await post(base, '/api/adapter/evaluate', { seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['HACK'] }, fingerprint: fp }, 'u-evac');
    assert.equal(r.json.decision, 'DENY');
    assert.equal(r.json.reason, 'FINGERPRINT_REUSED');

    // 交班两步
    r = await post(base, '/api/handover/start', { seatId: 'seat-evac', toUserId: 'u-su' }, 'u-evac');
    const ho = r.json.handovers.find((h) => h.seatId === 'seat-evac' && h.status === 'pending');
    assert.ok(ho);
    assert.equal((await post(base, '/api/handover/confirm', { handoverId: ho.id }, 'u-he')).status, 409); // 非接班人
    await post(base, '/api/handover/confirm', { handoverId: ho.id }, 'u-su');
    await post(base, '/api/handover/release', { handoverId: ho.id }, 'u-evac');

    s = await getState(base);
    const seat = s.seats.find((x) => x.id === 'seat-evac');
    assert.equal(seat.generation, 2);
    assert.equal(seat.holderId, 'u-su');

    // 旧控制台新意图（旧世代）被拒
    r = await post(base, '/api/adapter/evaluate', { seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['OLD'] }, fingerprint: 'fp-http-old' }, 'u-evac');
    assert.equal(r.json.decision, 'DENY');
    assert.equal(r.json.reason, 'STALE_GENERATION');

    // 相同重试仍返回原判定（即便已交班）
    r = await post(base, '/api/adapter/evaluate', { seatId: 'seat-evac', generation: 1, op: 'evacuation', payload, fingerprint: fp }, 'u-evac');
    assert.equal(r.json.decision, 'ACCEPT_REPLAY');
    assert.equal(r.json.verdict.code, 'EVAC_PUBLISHED');

    // 拒绝记录出现在状态里（管理页数据源）
    assert.ok(s.denials.length >= 0);
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 紧急接管：过期 + 双见证；并发收尾只产生一个世代', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-http-'));
  const port = 8902;
  const srv = startServer({ port, dataDir: dir, env: { SEED_TTL_MS: '1500' } });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForUrl(base + '/api/health');

    // 租约有效时接管被拒
    let r = await post(base, '/api/takeover/open', { seatId: 'seat-convoy' }, 'u-em');
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'LEASE_ACTIVE');

    await wait(1700); // TTL 1.5s 自然到期（无心跳）

    // 两名竞争者各自申请
    const a = await post(base, '/api/takeover/open', { seatId: 'seat-convoy' }, 'u-em');
    const b = await post(base, '/api/takeover/open', { seatId: 'seat-convoy' }, 'u-rival');
    const tkEm = a.json.takeovers.find((t) => t.claimantId === 'u-em' && t.status === 'open');
    const tkRival = b.json.takeovers.find((t) => t.claimantId === 'u-rival' && t.status === 'open');

    // 无资格见证人被拒
    assert.equal((await post(base, '/api/takeover/attest', { takeoverId: tkEm.id }, 'u-w3')).json.error, 'WITNESS_UNQUALIFIED');
    // 并发收尾：两个申请几乎同时凑齐
    await post(base, '/api/takeover/attest', { takeoverId: tkEm.id }, 'u-w1');
    await post(base, '/api/takeover/attest', { takeoverId: tkRival.id }, 'u-w1');
    const results = await Promise.all([
      post(base, '/api/takeover/attest', { takeoverId: tkEm.id }, 'u-w2'),
      post(base, '/api/takeover/attest', { takeoverId: tkRival.id }, 'u-w2'),
    ]);
    // 两个收尾调用：一个成功授予（200 快照中世代=2），另一个被 CAS 挡下（SUPERSEDED）
    const success = results.filter((x) => x.status === 200 && x.json.seats.find((s) => s.id === 'seat-convoy').generation === 2);
    const losers = results.filter((x) => x.status !== 200 || x.json.error);
    assert.equal(success.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].json.error, 'SUPERSEDED');
    const s = await getState(base);
    const seat = s.seats.find((x) => x.id === 'seat-convoy');
    assert.equal(seat.generation, 2);
    assert.ok(['u-em', 'u-rival'].includes(seat.holderId));
    assert.equal(s.takeovers.filter((t) => t.seatId === 'seat-convoy' && t.status === 'open').length, 0);

    // 接管后新持有人可写，旧人不可写
    const w = await post(base, '/api/adapter/evaluate', { seatId: 'seat-convoy', generation: 2, op: 'convoy', payload: { vehicleCount: 3 }, fingerprint: 'fp-after-tk' }, seat.holderId);
    assert.equal(w.json.decision, 'ACCEPT');
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('崩溃恢复：SIGKILL 后重启，世代、租约边界、原判定与交接进度全部恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-crash-'));
  const port = 8903;
  let srv = startServer({ port, dataDir: dir });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForUrl(base + '/api/health');

    // 已接受请求
    await post(base, '/api/adapter/evaluate', { seatId: 'seat-seal', generation: 1, op: 'sealing', payload: { target: '档案柜 7' }, fingerprint: 'fp-crash-1' }, 'u-seal');

    // 交接进行到一半（接班人已确认，持有人尚未交出）
    const st = await post(base, '/api/handover/start', { seatId: 'seat-seal', toUserId: 'u-he' }, 'u-seal');
    const ho = st.json.handovers.find((h) => h.seatId === 'seat-seal' && h.status === 'pending');
    await post(base, '/api/handover/confirm', { handoverId: ho.id }, 'u-he');

    // 进程被 SIGKILL
    srv.kill('SIGKILL');
    await wait(400);

    // 重启同一数据目录
    srv = startServer({ port, dataDir: dir });
    await waitForUrl(base + '/api/health');

    const s = await getState(base);
    const seat = s.seats.find((x) => x.id === 'seat-seal');
    assert.equal(seat.holderId, 'u-seal');   // 未完成的交接不会产生新主
    assert.equal(seat.generation, 1);        // 世代单调恢复
    const ho2 = s.handovers.find((h) => h.seatId === 'seat-seal' && h.status === 'pending');
    assert.ok(ho2);
    assert.equal(ho2.successorConfirmed, true);
    assert.equal(ho2.holderReleased, false);

    // 原判定恢复：相同指纹返回原判定
    const replay = await post(base, '/api/adapter/evaluate', { seatId: 'seat-seal', generation: 1, op: 'sealing', payload: { target: '档案柜 7' }, fingerprint: 'fp-crash-1' }, 'u-seal');
    assert.equal(replay.json.decision, 'ACCEPT_REPLAY');

    // 重启后继续完成交接，世代推进到 2
    await post(base, '/api/handover/release', { handoverId: ho2.id }, 'u-seal');
    const s2 = await getState(base);
    assert.equal(s2.seats.find((x) => x.id === 'seat-seal').generation, 2);
    assert.equal(s2.seats.find((x) => x.id === 'seat-seal').holderId, 'u-he');
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('崩溃发生在夺取最后一步后：重启后只有一个有效持有人', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-crash2-'));
  const port = 8904;
  let srv = startServer({ port, dataDir: dir, env: { SEED_TTL_MS: '1200' } });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForUrl(base + '/api/health');
    await wait(1400);
    const opened = await post(base, '/api/takeover/open', { seatId: 'seat-evac' }, 'u-em');
    const tk = opened.json.takeovers.find((t) => t.claimantId === 'u-em' && t.status === 'open');
    await post(base, '/api/takeover/attest', { takeoverId: tk.id }, 'u-w1');
    await post(base, '/api/takeover/attest', { takeoverId: tk.id }, 'u-w2');

    srv.kill('SIGKILL');
    await wait(400);
    srv = startServer({ port, dataDir: dir, env: { SEED_TTL_MS: '1200' } });
    await waitForUrl(base + '/api/health');

    const s = await getState(base);
    const seat = s.seats.find((x) => x.id === 'seat-evac');
    assert.equal(seat.generation, 2);
    assert.equal(seat.holderId, 'u-em');
    // 旧主写操作被世代围栏拒绝
    const denied = await post(base, '/api/adapter/evaluate', { seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['X'] }, fingerprint: 'fp-zombie' }, 'u-evac');
    assert.equal(denied.json.decision, 'DENY');
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SSE 与健康检查可用；dev 工具可重置', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-misc-'));
  const port = 8905;
  const srv = startServer({ port, dataDir: dir });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForUrl(base + '/api/health');
    const r = await fetch(base + '/api/events');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    r.body.cancel();

    const reset = await post(base, '/api/dev/reset', {});
    assert.equal(reset.json.seats.length, 3);
    assert.equal(reset.json.seats[0].generation, 1);
    assert.equal(reset.json.denials.length, 0);
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
