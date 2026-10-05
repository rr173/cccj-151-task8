'use strict';
const crypto = require('node:crypto');

/** 业务错误：携带机器可读码与 HTTP 状态，适配器据此给出 DENY 原因 */
class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

/** 规范化 JSON：对象键排序、递归稳定，保证两端指纹/载荷哈希一致 */
function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  const keys = Object.keys(x).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 业务载荷哈希：对规范化后的载荷 JSON 求 SHA-256 */
function payloadHashOf(payload) {
  return sha256Hex(stableStringify(payload));
}

function randomId(prefix) {
  return prefix + '-' + crypto.randomBytes(6).toString('hex');
}

module.exports = { DomainError, stableStringify, sha256Hex, payloadHashOf, randomId };
