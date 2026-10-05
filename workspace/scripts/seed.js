#!/usr/bin/env node
'use strict';
/**
 * 独立播种：初始化（或重置）数据目录并写入演示班次。
 *   node scripts/seed.js [数据目录]
 */
const path = require('node:path');
const { EventStore } = require('../src/store');
const { Clock } = require('../src/clock');
const { Coordinator } = require('../src/coordinator');
const { buildBootstrap, applySeed } = require('../src/seed');

const dir = path.resolve(process.argv[2] || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const ttlMs = Number(process.env.SEED_TTL_MS || 20000);
const reset = process.argv.includes('--reset');

const store = new EventStore(dir);
const coord = new Coordinator(store, new Clock(dir));
coord.init(buildBootstrap());
if (reset) coord.resetAndBootstrap(buildBootstrap());
if (coord.shifts.size === 0) applySeed(coord, ttlMs);

console.log(JSON.stringify({
  dataDir: dir,
  users: coord.users.size,
  shifts: coord.shifts.size,
  seats: coord.snapshot().seats.map((s) => ({ id: s.id, name: s.name, holder: s.holderName, generation: s.generation })),
  lastSeq: coord.lastSeq,
}, null, 2));
