'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * 只增事件日志（崩溃安全持久化）。
 *
 * 每个状态迁移 = 一行 JSON + 一次 append write + fsync：
 *  - 提交要么整行落盘，要么不存在，协调器状态只由日志重放得到；
 *  - POSIX 下单行小写入 + O_APPEND 原子，并发提交由 Node 单线程串行化；
 *  - 启动时修复尾部半行（模拟掉电导致最后一行只写了一半）。
 *
 * 因此“交出 / 确认 / 夺取”任何一步之后崩溃，重启都能恢复到唯一可判定状态，
 * 不会出现两个有效持有人，也不会出现无人可判定。
 */
class EventStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, 'events.log');
    if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, '');
    this.repairTail();
  }

  /** 截掉最后一个换行之后的残缺内容，并把文件修回完整边界 */
  repairTail() {
    const buf = fs.readFileSync(this.logPath);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    const lastNl = buf.lastIndexOf(0x0a);
    fs.writeFileSync(this.logPath, buf.subarray(0, lastNl + 1));
  }

  readAll() {
    const content = fs.readFileSync(this.logPath, 'utf8');
    if (!content) return [];
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /** 原子追加：一次 writeSync 写完整行并 fsync */
  append(event) {
    const line = JSON.stringify(event) + '\n';
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  }

  /** 开发环境重置演示数据 */
  reset() {
    fs.writeFileSync(this.logPath, '');
  }
}

module.exports = { EventStore };
