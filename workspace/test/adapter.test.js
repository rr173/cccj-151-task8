'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LeaseFenceAdapter, stableStringify } = require('../adapters/node/adapter');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('适配器：稳定序列化与载荷哈希', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify({ b: { y: 1, x: 2 }, a: [3, { z: 1 }] }), stableStringify({ a: [3, { z: 1 }], b: { x: 2, y: 1 } }));
});

test('适配器 SDK 端到端：ACCEPT / REPLAY / DENY', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-adp-'));
  const port = 8906;
  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, SEED_ON_START: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await wait(100); }

    const evac = new LeaseFenceAdapter({ baseUrl: base, actorId: 'u-evac' });

    // 首次
    const fp = 'fp-sdk-1';
    const first = await evac.beforeWrite({ seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['A'] }, fingerprint: fp });
    assert.equal(first.allowed, true);
    assert.equal(first.replay, false);
    assert.equal(first.verdict.ok, true);

    // 相同重试
    const again = await evac.beforeWrite({ seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['A'] }, fingerprint: fp });
    assert.equal(again.allowed, true);
    assert.equal(again.replay, true);
    assert.deepEqual(again.verdict, first.verdict);

    // 指纹复用冲突
    const clash = await evac.beforeWrite({ seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['B'] }, fingerprint: fp });
    assert.equal(clash.allowed, false);
    assert.equal(clash.reason, 'FINGERPRINT_REUSED');

    // 冒充持有人
    const seal = new LeaseFenceAdapter({ baseUrl: base, actorId: 'u-seal' });
    const wrong = await seal.beforeWrite({ seatId: 'seat-evac', generation: 1, op: 'evacuation', payload: { zones: ['A'] } });
    assert.equal(wrong.allowed, false);
    assert.equal(wrong.reason, 'NOT_HOLDER');

    // 心跳
    const hb = await evac.heartbeat({ seatId: 'seat-evac', generation: 1 });
    assert.equal(hb.ok, true);
    assert.ok(hb.expiresAt > Date.now());
  } finally {
    srv.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
