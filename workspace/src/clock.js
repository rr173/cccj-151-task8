'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * 协调器时钟：以服务端时钟为唯一权威，客户端时钟仅用于展示偏差。
 * offsetMs 为演示/测试用的逻辑时钟偏移，并持久化到 data/clock.json：
 * 即使“快进 25 秒”后进程崩溃重启，租约边界判断仍保持一致，不能靠重启续命。
 * 生产部署始终保持 0，所有租约边界均由协调器端时间计算，天然容忍客户端时钟漂移。
 */
class Clock {
  constructor(offsetMsOrDir) {
    this.file = null;
    this.offsetMs = 0;
    if (typeof offsetMsOrDir === 'string') {
      this.file = path.join(offsetMsOrDir, 'clock.json');
      if (fs.existsSync(this.file)) {
        try { this.offsetMs = JSON.parse(fs.readFileSync(this.file, 'utf8')).offsetMs | 0; } catch { /* 损坏按 0 处理 */ }
      }
    } else if (typeof offsetMsOrDir === 'number') {
      this.offsetMs = offsetMsOrDir;
    }
  }
  now() {
    return Date.now() + this.offsetMs;
  }
  setOffset(offsetMs) {
    this.offsetMs = offsetMs | 0;
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ offsetMs: this.offsetMs }));
    return this.offsetMs;
  }
}

module.exports = { Clock };
