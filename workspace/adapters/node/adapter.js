'use strict';
/**
 * 业务服务校验适配器（Node.js 参考实现）。
 *
 * 现有服务在执行“撤离方案发布 / 车队调度 / 封存审查”等写操作前，
 * 先调用 adapter.beforeWrite(...)：
 *   - ACCEPT / ACCEPT_REPLAY 才允许执行业务；REPLAY 时不要重复执行，直接沿用原结果；
 *   - DENY 必须拒绝写操作（旧世代、非持有人、租约过期、指纹冲突等）。
 *
 * 适配器只依赖 HTTP，任何语言都可用同样两个端点对接。
 */

const crypto = require('node:crypto');

function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}

function newFingerprint() {
  return 'fp-' + crypto.randomBytes(12).toString('hex');
}

class LeaseFenceAdapter {
  constructor({ baseUrl = 'http://localhost:8080', actorId, fetchImpl } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.actorId = actorId;
    // Node 18+ 自带 fetch；测试可注入
    this.fetch = fetchImpl || fetch;
  }

  payloadHash(payload) {
    return crypto.createHash('sha256').update(stableStringify(payload ?? null)).digest('hex');
  }

  /**
   * @returns {{allowed:boolean, replay?:boolean, decision:string, reason:string, verdict?:object, raw:object}}
   */
  async beforeWrite({ seatId, generation, op, payload, fingerprint }) {
    const fp = fingerprint || newFingerprint();
    const res = await this.fetch(this.baseUrl + '/api/adapter/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': this.actorId },
      body: JSON.stringify({ seatId, generation, op, payload, payloadHash: this.payloadHash(payload), fingerprint: fp }),
    });
    const raw = await res.json();
    if (!res.ok) {
      return { allowed: false, decision: 'DENY', reason: raw.error || 'HTTP_' + res.status, message: raw.message, fingerprint: fp, raw };
    }
    const allowed = raw.decision === 'ACCEPT' || raw.decision === 'ACCEPT_REPLAY';
    return {
      allowed,
      replay: raw.decision === 'ACCEPT_REPLAY',
      decision: raw.decision,
      reason: raw.reason,
      verdict: raw.verdict,
      fingerprint: fp,
      raw,
    };
  }

  /** 心跳续租：返回新的 expiresAt；旧世代/过期会抛 409 */
  async heartbeat({ seatId, generation }) {
    const res = await this.fetch(this.baseUrl + '/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': this.actorId },
      body: JSON.stringify({ seatId, generation }),
    });
    const raw = await res.json();
    if (!res.ok) throw Object.assign(new Error(raw.message || 'heartbeat rejected'), { code: raw.error, status: res.status, raw });
    return raw;
  }
}

module.exports = { LeaseFenceAdapter, stableStringify, newFingerprint };
