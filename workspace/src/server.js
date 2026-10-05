'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventStore } = require('./store');
const { Clock } = require('./clock');
const { Coordinator } = require('./coordinator');
const { buildBootstrap, applySeed } = require('./seed');
const { DomainError } = require('./util');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SEED_TTL = Number(process.env.SEED_TTL_MS || 20000);
const DEV = process.env.ENABLE_DEV_TOOLS !== '0'; // 默认开启，便于演示；生产置 0

const store = new EventStore(DATA_DIR);
const clock = new Clock(DATA_DIR);
const coord = new Coordinator(store, clock);
coord.init(buildBootstrap());
if (coord.shifts.size === 0 && process.env.SEED_ON_START !== '0') {
  // 全新数据目录（事件日志为空）才播种；崩溃重启时班次已在日志中，绝不重复创建
  if (process.env.SEED_IF_EMPTY === '1' || coord.lastSeq <= 1) {
    applySeed(coord, SEED_TTL);
  }
}

// ---------------------------------------------------------------- SSE

const sseClients = new Set();
let lastSnapshot = null;
function publish() {
  lastSnapshot = coord.snapshot(null);
  const body = `event: state\ndata: ${JSON.stringify(lastSnapshot)}\n\n`;
  for (const res of sseClients) {
    try { res.write(`event: tick\ndata: ${JSON.stringify({ serverNow: clock.now() })}\n\n`); res.write(body); } catch { /* 客户端已断开 */ }
  }
}
coord.on('committed', publish);
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(`event: tick\ndata: ${JSON.stringify({ serverNow: clock.now() })}\n\n`); } catch { /* noop */ }
  }
}, 1000).unref();

// ---------------------------------------------------------------- HTTP 工具

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new DomainError('BAD_REQUEST', '请求体过大', 413)); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new DomainError('BAD_REQUEST', '非法 JSON', 400)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof DomainError) return sendJson(res, err.status, { error: err.code, message: err.message });
  // eslint-disable-next-line no-console
  console.error(err);
  sendJson(res, 500, { error: 'INTERNAL', message: String(err && err.message || err) });
}

/** 模拟控制台在同一终端切换身份：actor 由请求体 / 头 / 查询参数提供 */
function actorOf(req, body) {
  return (body && body.actorId) || req.headers['x-actor-id'] || new URL(req.url, 'http://x').searchParams.get('as');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    // 状态流 / 只读
    if (req.method === 'GET' && p === '/api/state') {
      const as = url.searchParams.get('as');
      return sendJson(res, 200, coord.snapshot(as || null));
    }
    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, serverNow: clock.now(), lastSeq: coord.lastSeq });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(coord.snapshot(null))}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'GET' && (p === '/' || p.startsWith('/')) && !p.startsWith('/api/')) {
      return serveStatic(req, res, p);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

    const body = await readJson(req);
    const actorId = actorOf(req, body);

    switch (p) {
      // 班次与资格
      case '/api/shifts':
        return sendJson(res, 200, coord.createShift({ ...body, actorId }));
      case '/api/witness-qualification':
        return sendJson(res, 200, coord.setWitnessQualified({ actorId, userId: body.userId, qualified: body.qualified }));

      // 心跳续租
      case '/api/heartbeat':
        return sendJson(res, 200, coord.heartbeat({ seatId: body.seatId, holderId: actorId, generation: body.generation }));

      // 协作交班
      case '/api/handover/start':
        return sendJson(res, 200, coord.startHandover({ seatId: body.seatId, actorId, toUserId: body.toUserId }));
      case '/api/handover/confirm':
        return sendJson(res, 200, coord.confirmHandover({ handoverId: body.handoverId, userId: actorId }));
      case '/api/handover/release':
        return sendJson(res, 200, coord.releaseHandover({ handoverId: body.handoverId, userId: actorId }));
      case '/api/handover/cancel':
        return sendJson(res, 200, coord.cancelHandover({ handoverId: body.handoverId, userId: actorId, reason: body.reason }));

      // 紧急接管
      case '/api/takeover/open':
        return sendJson(res, 200, coord.openTakeover({ seatId: body.seatId, claimantId: actorId, expectedGeneration: body.expectedGeneration }));
      case '/api/takeover/attest':
        return sendJson(res, 200, coord.attestTakeover({ takeoverId: body.takeoverId, witnessId: actorId }));

      // 业务围栏（现有服务调用的校验适配器 HTTP 面）
      case '/api/adapter/evaluate':
        return sendJson(res, 200, coord.evaluateRequest({
          seatId: body.seatId, holderId: actorId, generation: body.generation,
          op: body.op, payload: body.payload, payloadHash: body.payloadHash, fingerprint: body.fingerprint,
        }));

      // 开发/演示工具
      case '/api/dev/clock': {
        if (!DEV) break;
        clock.setOffset(Number(body.offsetMs || 0));
        publish();
        return sendJson(res, 200, { ok: true, serverNow: clock.now(), offsetMs: clock.offsetMs });
      }
      case '/api/dev/crash': {
        if (!DEV) break;
        // 立即模拟掉电：直接 SIGKILL 语义退出，已 fsync 的提交全部保留，未落盘的全部丢失
        // eslint-disable-next-line no-console
        console.error(`[dev-crash] 模拟崩溃 @seq=${coord.lastSeq}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, crashed: true, lastSeq: coord.lastSeq }));
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
        return;
      }
      case '/api/dev/reset': {
        if (!DEV) break;
        clock.setOffset(0); // 先归零时钟，再播种，保证新席位倒计时正好是 TTL
        coord.resetAndBootstrap(buildBootstrap());
        applySeed(coord, SEED_TTL);
        publish();
        return sendJson(res, 200, coord.snapshot(null));
      }
      default:
        return sendJson(res, 404, { error: 'NOT_FOUND', path: p });
    }
    if (!DEV) return sendJson(res, 404, { error: 'NOT_FOUND' });
    return sendJson(res, 404, { error: 'NOT_FOUND', path: p });
  } catch (err) {
    return sendError(res, err);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`值班席位租约协调器已启动: http://localhost:${PORT}  (data: ${DATA_DIR}, dev tools: ${DEV})`);
});

module.exports = { server, coord, clock };
