'use strict';
const { EventEmitter } = require('node:events');
const { DomainError, payloadHashOf, randomId } = require('./util');

/**
 * 值班席位租约协调器（领域内核，纯逻辑 + 事件日志）。
 *
 * 核心概念：
 *   seat       值班席位，唯一持有人 currentHolderId + 单调世代 generation
 *   lease      租约 expiresAt（宽限边界）；未到期任何人不能取得该席位
 *   handover   协作交接（接班人确认 + 持有人交出，两步都完成才原子切换世代）
 *   takeover   紧急接管（租约失联到期 + 两名互不相同且具备资格的见证人）
 *   verdict    业务请求判定（席位+世代围栏、指纹幂等、指纹复用内容冲突拒绝）
 *
 * 所有写操作经 _commit() 串行化：先在当前状态上校验 CAS，再原子追加事件。
 */
class Coordinator extends EventEmitter {
  constructor(store, clock) {
    super();
    this.setMaxListeners(0);
    this.store = store;
    this.clock = clock;
    this.initialized = false;
    this.bootstrap = null;
    this.users = new Map();       // userId -> { id, name, role, witnessQualified, active }
    this.shifts = new Map();      // shiftId -> { id, name, startedAt, seatIds }
    this.seats = new Map();       // seatId -> { id, name, kind, shiftId, ttlMs, currentHolderId, generation, expiresAt, handoverId }
    this.handovers = new Map();   // handoverId -> { id, seatId, gen, fromHolderId, toUserId, successorConfirmed, holderReleased, status, createdAt }
    this.takeovers = new Map();   // takeoverId -> { id, seatId, gen, claimantId, witnesses: Map(witnessId->at), status, closedReason, createdAt }
    this.verdicts = new Map();    // fingerprint -> 接受判定（成功/业务失败），保证相同重试返回原判定
    this.denials = [];            // 最近被围栏/复用冲突拒绝的操作（审计，管理页展示）
    this.lastSeq = 0;
  }

  // ---------------------------------------------------------------- 装载

  init(bootstrapPayload) {
    const events = this.store.readAll();
    for (const ev of events) this._apply(ev);
    if (!this.bootstrap && bootstrapPayload) {
      this._commit({ type: 'Bootstrapped', payload: bootstrapPayload }, false);
    }
    this.initialized = true;
  }

  resetAndBootstrap(bootstrapPayload) {
    this.store.reset();
    this.bootstrap = null;
    this.users.clear();
    this.shifts.clear();
    this.seats.clear();
    this.handovers.clear();
    this.takeovers.clear();
    this.verdicts.clear();
    this.denials.length = 0;
    this.lastSeq = 0;
    this._commit({ type: 'Bootstrapped', payload: bootstrapPayload }, false);
  }

  /** 原子提交：构造事件 -> 追加落盘 -> 应用到内存 -> 通知订阅者 */
  _commit(partial, notify = true) {
    const event = { id: ++this.lastSeq, ts: this.clock.now(), ...partial };
    this.store.append(event);
    this._apply(event);
    if (notify) this.emit('committed', event);
    return event;
  }

  // ---------------------------------------------------------------- 事件应用（重放）

  _apply(ev) {
    this.lastSeq = Math.max(this.lastSeq, ev.id);
    const p = ev.payload || {};
    switch (ev.type) {
      case 'Bootstrapped': {
        this.bootstrap = { at: ev.ts, ...p };
        for (const u of p.users || []) {
          this.users.set(u.id, { id: u.id, name: u.name, role: u.role, witnessQualified: !!u.witnessQualified, active: true });
        }
        break;
      }
      case 'UserQualifiedChanged': {
        const u = this.users.get(p.userId);
        if (u) u.witnessQualified = !!p.qualified;
        break;
      }
      case 'ShiftCreated': {
        this.shifts.set(p.shift.id, { ...p.shift, createdAt: ev.ts });
        for (const s of p.seats) {
          this.seats.set(s.id, {
            id: s.id, name: s.name, kind: s.kind, shiftId: p.shift.id,
            ttlMs: s.ttlMs, currentHolderId: s.holderId, generation: s.generation,
            expiresAt: ev.ts + s.ttlMs, handoverId: null,
          });
        }
        break;
      }
      case 'LeaseRenewed': {
        const s = this.seats.get(p.seatId);
        if (s && s.currentHolderId === p.holderId && s.generation === p.generation) {
          s.expiresAt = ev.ts + s.ttlMs;
        }
        break;
      }
      case 'HandoverStarted': {
        this.handovers.set(p.handover.id, { ...p.handover, startedAt: ev.ts });
        const s = this.seats.get(p.handover.seatId);
        if (s && s.generation === p.handover.gen) s.handoverId = p.handover.id;
        break;
      }
      case 'HandoverConfirmed': {
        const h = this.handovers.get(p.handoverId);
        if (h) h.successorConfirmed = true;
        break;
      }
      case 'HandoverReleased': {
        const h = this.handovers.get(p.handoverId);
        if (h) h.holderReleased = true;
        break;
      }
      case 'HandoverCanceled': {
        const h = this.handovers.get(p.handoverId);
        if (h) { h.status = 'canceled'; h.cancelReason = p.reason; }
        const s = this.seats.get(p.seatId);
        if (s && s.handoverId === p.handoverId) s.handoverId = null;
        break;
      }
      case 'SeatGranted': {
        const s = this.seats.get(p.seatId);
        if (s) {
          s.currentHolderId = p.holderId;
          s.generation = p.newGeneration;
          s.expiresAt = ev.ts + s.ttlMs;
          s.handoverId = null;
        }
        for (const h of this.handovers.values()) {
          if (h.seatId === p.seatId && h.status === 'pending') {
            h.status = (p.reason === 'handover' && h.id === p.handoverId) ? 'completed' : 'superseded';
          }
        }
        for (const t of this.takeovers.values()) {
          if (t.seatId === p.seatId && t.status === 'open') {
            t.status = 'superseded'; t.closedReason = 'seat-granted';
          }
        }
        break;
      }
      case 'TakeoverOpened': {
        this.takeovers.set(p.takeover.id, {
          ...p.takeover, witnesses: new Map((p.takeover.witnesses || []).map((w) => [w, ev.ts])), openedAt: ev.ts,
        });
        break;
      }
      case 'TakeoverAttested': {
        const t = this.takeovers.get(p.takeoverId);
        if (t) t.witnesses.set(p.witnessId, ev.ts);
        break;
      }
      case 'TakeoverClosed': {
        const t = this.takeovers.get(p.takeoverId);
        if (t) { t.status = p.status; t.closedReason = p.reason; }
        break;
      }
      case 'RequestVerdicted': {
        if (p.outcome === 'accepted') this.verdicts.set(p.fingerprint, p);
        break;
      }
      case 'RequestDenied': {
        this.denials.unshift(p);
        if (this.denials.length > 200) this.denials.length = 200;
        break;
      }
      default:
        // 前向兼容：未知事件忽略，日志仍是唯一事实来源
        break;
    }
  }

  // ---------------------------------------------------------------- 校验辅助

  _user(userId) {
    const u = this.users.get(userId);
    if (!u || !u.active) throw new DomainError('UNKNOWN_USER', `未知或已停用用户: ${userId}`, 404);
    return u;
  }
  _seat(seatId) {
    const s = this.seats.get(seatId);
    if (!s) throw new DomainError('UNKNOWN_SEAT', `未知席位: ${seatId}`, 404);
    return s;
  }
  _activeHandover(seatId) {
    for (const h of this.handovers.values()) {
      if (h.seatId === seatId && h.status === 'pending') return h;
    }
    return null;
  }
  _activeTakeover(seatId, gen, claimantId) {
    for (const t of this.takeovers.values()) {
      if (t.seatId === seatId && t.gen === gen && t.status === 'open' &&
          (claimantId === undefined || t.claimantId === claimantId)) return t;
    }
    return null;
  }
  _leaseAlive(seat) {
    return seat.expiresAt > this.clock.now();
  }

  // ---------------------------------------------------------------- 班次 / 资格

  createShift({ actorId, name, seats }) {
    this._user(actorId);
    if (!Array.isArray(seats) || seats.length === 0) {
      throw new DomainError('BAD_REQUEST', '班次至少包含一个席位', 400);
    }
    const shift = { id: randomId('shift'), name: name || '未命名班次', createdBy: actorId };
    const seatPayload = seats.map((s) => {
      const holder = this._user(s.holderId);
      if (!['evacuation', 'convoy', 'sealing'].includes(s.kind)) {
        throw new DomainError('BAD_REQUEST', `席位类型非法: ${s.kind}`, 400);
      }
      return { id: s.id || randomId('seat'), name: s.name, kind: s.kind, ttlMs: s.ttlMs || 20000, holderId: holder.id, generation: 1 };
    });
    this._commit({ type: 'ShiftCreated', payload: { shift, seats: seatPayload } });
    return this.snapshot(actorId);
  }

  setWitnessQualified({ actorId, userId, qualified }) {
    this._user(actorId);
    this._user(userId);
    this._commit({ type: 'UserQualifiedChanged', payload: { userId, qualified: !!qualified, by: actorId } });
    return this.snapshot(actorId);
  }

  // ---------------------------------------------------------------- 心跳 / 续租

  heartbeat({ seatId, holderId, generation }) {
    this._user(holderId);
    const s = this._seat(seatId);
    // 基于旧世代的请求不能续租：CAS
    if (s.generation !== generation) {
      throw new DomainError('STALE_GENERATION', `世代 ${generation} 已过期，当前为 ${s.generation}，旧控制台不能续租`, 409);
    }
    if (s.currentHolderId !== holderId) {
      throw new DomainError('NOT_HOLDER', '当前持有人不匹配，拒绝续租', 409);
    }
    // 租约一旦越过宽限边界，持有人身份即失联失效，不能再续租；必须重新取得席位
    if (!this._leaseAlive(s)) {
      throw new DomainError('LEASE_EXPIRED', '租约已越过宽限边界，旧持有人不能续租，请交班或由见证人接管', 409);
    }
    // 已交出（交接待接班人确认）的旧持有人不能续租，防止交出后继续当主
    if (s.handoverId) {
      const h = this.handovers.get(s.handoverId);
      if (h && h.holderReleased) {
        throw new DomainError('SURRENDERED', '席位已交出，等待接班人确认生效，不能续租', 409);
      }
    }
    this._commit({ type: 'LeaseRenewed', payload: { seatId, holderId, generation, ttlMs: s.ttlMs } });
    return { ok: true, seatId, generation, expiresAt: s.expiresAt };
  }

  // ---------------------------------------------------------------- 协作交班

  startHandover({ seatId, actorId, toUserId }) {
    this._user(actorId);
    const candidate = this._user(toUserId);
    const s = this._seat(seatId);
    if (actorId !== s.currentHolderId) {
      throw new DomainError('NOT_HOLDER', '只有当前持有人能发起交接', 409);
    }
    if (this._activeHandover(seatId)) {
      throw new DomainError('HANDOVER_OPEN', '该席位已有进行中的交接', 409);
    }
    if (toUserId === actorId) {
      throw new DomainError('BAD_REQUEST', '接班人不能是持有人自己', 400);
    }
    const handover = {
      id: randomId('ho'), seatId: s.id, gen: s.generation,
      fromHolderId: actorId, toUserId: candidate.id,
      successorConfirmed: false, holderReleased: false, status: 'pending',
    };
    this._commit({ type: 'HandoverStarted', payload: { handover } });
    return this.snapshot(actorId);
  }

  confirmHandover({ handoverId, userId }) {
    this._user(userId);
    const h0 = this.handovers.get(handoverId);
    if (!h0) throw new DomainError('UNKNOWN_HANDOVER', '未知交接', 404);
    // 已生效后的重复确认：对当事人幂等返回，不报错也不重复推进世代
    if (h0.status === 'completed') return this.snapshot(userId);
    const h = this._requirePendingHandover(handoverId);
    if (h.toUserId !== userId) {
      throw new DomainError('NOT_CANDIDATE', '只有指定接班人能确认交接', 409);
    }
    if (h.successorConfirmed) return this.snapshot(userId); // 确认幂等
    this._commit({ type: 'HandoverConfirmed', payload: { handoverId, userId } });
    return this._tryCompleteHandover(h.id, userId);
  }

  releaseHandover({ handoverId, userId }) {
    this._user(userId);
    const h0 = this.handovers.get(handoverId);
    if (!h0) throw new DomainError('UNKNOWN_HANDOVER', '未知交接', 404);
    // 已生效后的重复交出：幂等返回
    if (h0.status === 'completed') return this.snapshot(userId);
    const h = this._requirePendingHandover(handoverId);
    if (h.fromHolderId !== userId) {
      throw new DomainError('NOT_HOLDER', '只有当前持有人能交出席位', 409);
    }
    if (h.holderReleased) return this.snapshot(userId); // 交出幂等
    this._commit({ type: 'HandoverReleased', payload: { handoverId, userId } });
    return this._tryCompleteHandover(h.id, userId);
  }

  cancelHandover({ handoverId, userId, reason }) {
    this._user(userId);
    const h = this._requirePendingHandover(handoverId);
    if (h.fromHolderId !== userId && h.toUserId !== userId) {
      throw new DomainError('FORBIDDEN', '只有交接双方能取消', 403);
    }
    this._commit({ type: 'HandoverCanceled', payload: { handoverId, seatId: h.seatId, reason: reason || 'canceled', by: userId } });
    return this.snapshot(userId);
  }

  _requirePendingHandover(handoverId) {
    const h = this.handovers.get(handoverId);
    if (!h) throw new DomainError('UNKNOWN_HANDOVER', '未知交接', 404);
    if (h.status !== 'pending') {
      throw new DomainError('HANDOVER_NOT_PENDING', `交接已 ${h.status}，不能继续`, 409);
    }
    const s = this.seats.get(h.seatId);
    if (!s || s.generation !== h.gen) {
      throw new DomainError('STALE_GENERATION', '席位世代已推进，该交接作废', 409);
    }
    return h;
  }

  /**
   * 接班人确认 与 持有人交出 可按任意顺序到达：两步都完成时在此原子授予新世代。
   * 崩溃发生在授予前：状态仍完整保留两步进度，重启后任一方重试即继续；
   * 崩溃发生在授予后：新世代已落盘，重放得到唯一新持有人。绝无双主窗口。
   */
  _tryCompleteHandover(handoverId, actorId) {
    const h = this.handovers.get(handoverId);
    const s = h && this.seats.get(h.seatId);
    if (h && h.status === 'pending' && h.successorConfirmed && h.holderReleased && s && s.generation === h.gen) {
      this._commit({
        type: 'SeatGranted',
        payload: { seatId: s.id, reason: 'handover', handoverId: h.id, holderId: h.toUserId, newGeneration: s.generation + 1 },
      });
    }
    return this.snapshot(actorId);
  }

  // ---------------------------------------------------------------- 紧急接管

  openTakeover({ seatId, claimantId, expectedGeneration }) {
    this._user(claimantId);
    const s = this._seat(seatId);
    // 基于旧世代发起的请求最先拒绝（围栏 CAS 优先于租约状态）
    if (expectedGeneration != null && expectedGeneration !== s.generation) {
      throw new DomainError('STALE_GENERATION', `接管请求基于旧世代 ${expectedGeneration}，当前 ${s.generation}`, 409);
    }
    if (claimantId === s.currentHolderId) {
      throw new DomainError('BAD_REQUEST', '原持有人不能紧急接管自己的席位（请使用交接或续租）', 400);
    }
    if (this._leaseAlive(s)) {
      throw new DomainError('LEASE_ACTIVE', '租约尚未越过宽限边界，不允许另一人取得该席位', 409);
    }
    // 同一竞争者重复申请幂等；不同竞争者各自持有申请，夺取时 CAS 决出唯一胜者
    const existing = this._activeTakeover(s.id, s.generation, claimantId);
    if (existing) return this.snapshot(claimantId);
    const takeover = {
      id: randomId('tk'), seatId: s.id, gen: s.generation,
      claimantId, witnesses: new Map(), status: 'open',
    };
    this._commit({ type: 'TakeoverOpened', payload: { takeover: { ...takeover, witnesses: [] } } });
    return this.snapshot(claimantId);
  }

  attestTakeover({ takeoverId, witnessId }) {
    this._user(witnessId);
    const t = this.takeovers.get(takeoverId);
    if (!t) throw new DomainError('UNKNOWN_TAKEOVER', '未知接管申请', 404);
    const s = this._seat(t.seatId);

    // 席位已被授予（交班成功或他人接管成功）：本申请作废，任何后续见证都不能改变归属
    if (s.generation !== t.gen || t.status !== 'open') {
      throw new DomainError('SUPERSEDED', '席位归属已定，该接管申请已作废', 409);
    }
    // 见证人与申请人必须不同；两名见证人也必须互不相同（最先判定，申请人永远不能自证）
    if (witnessId === t.claimantId) {
      throw new DomainError('WITNESS_CONFLICT', '申请人不能同时担任见证人', 409);
    }
    // 过早接管：失联未达门槛（租约未到宽限边界）
    if (this._leaseAlive(s)) {
      throw new DomainError('LEASE_ACTIVE', '原持有人失联尚未达到门槛（租约未到期），过早接管被拒绝', 409);
    }
    const witness = this._user(witnessId);
    // 见证资格变化：资格被撤销后不能见证
    if (!witness.witnessQualified) {
      throw new DomainError('WITNESS_UNQUALIFIED', '该见证人不具备资格', 409);
    }
    // 重复见证：同一见证人只能记一次，不计入第二名
    if (t.witnesses.has(witnessId)) {
      throw new DomainError('DUPLICATE_WITNESS', '该见证人已见证，不能重复计数', 409);
    }
    this._commit({ type: 'TakeoverAttested', payload: { takeoverId, witnessId } });
    return this._trySeize(t.id, witnessId);
  }

  /**
   * 凑齐两名合格且互不相同的见证人即原子夺取。
   * 并发竞争者同时凑齐：第二个提交在 CAS 上失败（世代已推进），只产生一个 +1 的连续世代。
   */
  _trySeize(takeoverId, actorId) {
    const t = this.takeovers.get(takeoverId);
    const s = t && this.seats.get(t.seatId);
    if (!t || t.status !== 'open' || !s) return this.snapshot(actorId);
    if (s.generation !== t.gen) {
      this._commit({ type: 'TakeoverClosed', payload: { takeoverId: t.id, seatId: s.id, status: 'superseded', reason: 'stale-generation' } });
      return this.snapshot(actorId);
    }
    if (t.witnesses.size >= 2) {
      const witnessIds = [...t.witnesses.keys()];
      // 提交瞬间再次校验资格，资格变化无法蒙混过关
      const bothQualified = witnessIds.every((id) => this.users.get(id)?.witnessQualified);
      const distinct = new Set(witnessIds).size === 2 && !witnessIds.includes(t.claimantId);
      if (!this._leaseAlive(s) && bothQualified && distinct) {
        this._commit({
          type: 'SeatGranted',
          payload: { seatId: s.id, reason: 'emergency-takeover', takeoverId: t.id, holderId: t.claimantId, newGeneration: s.generation + 1 },
        });
        return this.snapshot(actorId);
      }
    }
    return this.snapshot(actorId);
  }

  // ---------------------------------------------------------------- 业务请求围栏（校验适配器核心）

  /**
   * 业务服务在执行写操作前调用。判定规则：
   *  1) 相同 (fingerprint, seat, generation, op, payloadHash) 的重试 -> 返回原判定（幂等）
   *  2) 复用 fingerprint 但席位/世代/操作/载荷任一不同 -> DENY FINGERPRINT_REUSED（冲突）
   *  3) 席位/世代/持有人 CAS 不匹配、租约过期、已交出 -> DENY（旧控制台写操作被拒）
   *  4) 通过 -> ACCEPTED 并持久化；交班/接管永远不回滚已接受结果
   */
  evaluateRequest({ seatId, holderId, generation, op, payload, payloadHash, fingerprint }) {
    const now = this.clock.now();
    const id = randomId('req');
    if (!fingerprint || typeof fingerprint !== 'string') {
      throw new DomainError('BAD_REQUEST', '请求必须携带指纹 fingerprint', 400);
    }
    if (!['evacuation', 'convoy', 'sealing'].includes(op)) {
      throw new DomainError('BAD_REQUEST', `未知操作类型: ${op}`, 400);
    }
    const serverHash = payloadHashOf(payload ?? null);
    if (payloadHash && payloadHash !== serverHash) {
      throw new DomainError('PAYLOAD_HASH_MISMATCH', '载荷与 payloadHash 不一致，拒绝（防篡改）', 409);
    }

    // 1) 完全相同的重试：返回原判定
    const prior = this.verdicts.get(fingerprint);
    if (prior) {
      const same = prior.seatId === seatId && prior.generation === generation &&
        prior.holderId === holderId && prior.op === op && prior.payloadHash === serverHash;
      if (same) {
        return { decision: 'ACCEPT_REPLAY', verdict: prior.result, reason: 'IDEMPOTENT_REPLAY', id: prior.id, ts: prior.ts };
      }
      // 2) 复用指纹但内容不同：拒绝，记审计
      const denial = { id, ts: now, fingerprint, seatId, holderId, generation, op, payloadHash: serverHash, decision: 'DENY', reason: 'FINGERPRINT_REUSED', detail: '指纹相同但席位/世代/操作/载荷不同', original: { seatId: prior.seatId, generation: prior.generation, op: prior.op } };
      this._commit({ type: 'RequestDenied', payload: denial });
      return { decision: 'DENY', reason: 'FINGERPRINT_REUSED', id, ts: now };
    }

    // 3) 围栏检查
    const seat = this.seats.get(seatId);
    const deny = (reason, detail) => {
      const d = { id, ts: now, fingerprint, seatId, holderId, generation, op, payloadHash: serverHash, decision: 'DENY', reason, detail };
      this._commit({ type: 'RequestDenied', payload: d });
      return { decision: 'DENY', reason, detail, id, ts: now };
    };
    if (!seat) return deny('UNKNOWN_SEAT');
    if (seat.generation !== generation) return deny('STALE_GENERATION', `当前世代 ${seat.generation}，请求基于旧世代 ${generation}`);
    if (seat.currentHolderId !== holderId) return deny('NOT_HOLDER', `当前持有人为 ${seat.currentHolderId}`);
    if (seat.expiresAt <= now) return deny('LEASE_EXPIRED', '租约已过期，写操作被拒');
    if (seat.handoverId) {
      const h = this.handovers.get(seat.handoverId);
      if (h && h.holderReleased) return deny('SURRENDERED', '席位已交出，等待新世代生效');
    }
    if (seat.kind !== op) return deny('KIND_MISMATCH', `该席位业务为 ${seat.kind}，不能执行 ${op}`);

    // 4) 接受：结果只与操作与载荷有关（示例判定器：内容检查），结果被持久化
    const result = this._businessResult(op, payload);
    const verdict = { id, ts: now, fingerprint, seatId, holderId, generation, op, payloadHash: serverHash, outcome: 'accepted', result };
    this._commit({ type: 'RequestVerdicted', payload: verdict });
    return { decision: 'ACCEPT', verdict: result, reason: 'FENCE_OK', id, ts: now };
  }

  /** 示例业务判定：现有服务可替换为真实执行结果；协调器只负责记住“原判定” */
  _businessResult(op, payload) {
    const body = payload && typeof payload === 'object' ? payload : {};
    if (op === 'evacuation') {
      const zones = body.zones || body.zone || [];
      const list = Array.isArray(zones) ? zones : [zones];
      if (list.length === 0) return { code: 'EVAC_EMPTY', ok: false, message: '未指定撤离区域' };
      return { code: 'EVAC_PUBLISHED', ok: true, message: `撤离方案已发布，覆盖 ${list.length} 个区域`, zones: list };
    }
    if (op === 'convoy') {
      const vehicles = Number(body.vehicleCount ?? body.vehicles ?? 0);
      if (vehicles <= 0) return { code: 'CONVOY_NO_VEHICLE', ok: false, message: '车队车辆数必须大于 0' };
      return { code: 'CONVOY_DISPATCHED', ok: true, message: `车队已调度，共 ${vehicles} 辆车`, vehicles };
    }
    // sealing
    if (!body.target) return { code: 'SEAL_NO_TARGET', ok: false, message: '未指定封存目标' };
    return { code: 'SEAL_REVIEW_ACCEPTED', ok: true, message: `封存审查通过：${body.target}`, target: body.target };
  }

  // ---------------------------------------------------------------- 视图

  seatView(s) {
    const alive = this._leaseAlive(s);
    return {
      id: s.id, name: s.name, kind: s.kind, shiftId: s.shiftId, ttlMs: s.ttlMs,
      holderId: s.currentHolderId, holderName: this.users.get(s.currentHolderId)?.name || null,
      generation: s.generation, expiresAt: s.expiresAt, serverNow: this.clock.now(),
      remainingMs: Math.max(0, s.expiresAt - this.clock.now()), status: alive ? (s.handoverId ? 'surrendering' : 'held') : 'expired',
      handoverId: s.handoverId,
    };
  }

  snapshot(actorId) {
    const seats = [...this.seats.values()].map((s) => this.seatView(s));
    const handovers = [...this.handovers.values()].reverse().map((h) => ({
      ...h,
      toUserName: this.users.get(h.toUserId)?.name,
      fromUserName: this.users.get(h.fromHolderId)?.name,
      seatName: this.seats.get(h.seatId)?.name,
    }));
    const takeovers = [...this.takeovers.values()].reverse().map((t) => ({
      ...t,
      witnesses: [...t.witnesses.keys()],
      claimantName: this.users.get(t.claimantId)?.name,
      witnessNames: [...t.witnesses.keys()].map((id) => this.users.get(id)?.name),
      seatName: this.seats.get(t.seatId)?.name,
      currentGeneration: this.seats.get(t.seatId)?.generation,
      leaseActive: this.seats.get(t.seatId) ? this._leaseAlive(this.seats.get(t.seatId)) : null,
    }));
    return {
      serverNow: this.clock.now(),
      clockOffsetMs: this.clock.offsetMs,
      actorId: actorId || null,
      bootstrap: this.bootstrap,
      users: [...this.users.values()],
      shifts: [...this.shifts.values()].map((sh) => ({ ...sh, seats: seats.filter((s) => s.shiftId === sh.id) })),
      seats,
      handovers,
      takeovers,
      accepted: [...this.verdicts.values()].reverse().slice(0, 100),
      denials: this.denials.slice(0, 100),
      lastSeq: this.lastSeq,
    };
  }
}

module.exports = { Coordinator };
