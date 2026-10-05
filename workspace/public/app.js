'use strict';
/* 管理页面 + 多身份模拟控制台（原生 JS，SSE 实时更新） */

const OP_LABEL = { evacuation: '撤离方案发布', convoy: '车队调度', sealing: '封存审查' };
const KIND_ICON = { evacuation: '🏃', convoy: '🚚', sealing: '🔒' };

const state = {
  snap: null,
  me: localStorage.getItem('duty.me') || null,
  forms: {}, // seatId -> 控制台表单草稿（重渲染时保留输入）
  hbTimers: {}, // seatId -> interval
};

// ---------------------------------------------------------------- DOM 工具

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const esc = (s) => String(s ?? '');
function formOf(seatId) {
  if (!state.forms[seatId]) {
    const seat = state.snap.seats.find((s) => s.id === seatId);
    const sample = seat?.kind === 'evacuation'
      ? { zones: ['A-01', 'B-02'] }
      : seat?.kind === 'convoy' ? { vehicleCount: 6 } : { target: '3 号库房·档案柜 7' };
    state.forms[seatId] = { payload: JSON.stringify(sample, null, 0), fp: newFp(), gen: seat?.generation ?? 1, reuse: false, mutate: false, autoHb: false };
  }
  return state.forms[seatId];
}
function newFp() { return 'fp-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''); }

// ---------------------------------------------------------------- API

async function api(path, body = {}) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': state.me || '' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { toast(`❌ ${data.message || data.error}`, 'err'); return null; }
    if (data && data.seats) state.snap = data; // 命令响应直接带快照
    return data;
  } catch (e) {
    toast('❌ 请求失败：' + e.message, 'err');
    return null;
  }
}

function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  $('#toast-wrap').append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3600);
}

// ---------------------------------------------------------------- SSE

let serverNow = Date.now();
let serverNowReceivedAt = performance.now();
function approxNow() { return serverNow + (performance.now() - serverNowReceivedAt); }

const es = new EventSource('/api/events');
es.addEventListener('state', (e) => {
  state.snap = JSON.parse(e.data);
  serverNow = state.snap.serverNow; serverNowReceivedAt = performance.now();
  setConn(true);
  renderAll();
});
es.addEventListener('tick', (e) => {
  serverNow = JSON.parse(e.data).serverNow; serverNowReceivedAt = performance.now();
  updateCountdowns();
});
es.onerror = () => setConn(false);
setInterval(async () => {
  if (es.readyState === EventSource.CLOSED) {
    const r = await fetch('/api/state' + (state.me ? `?as=${encodeURIComponent(state.me)}` : ''));
    if (r.ok) { state.snap = await r.json(); serverNow = state.snap.serverNow; serverNowReceivedAt = performance.now(); renderAll(); setConn(true); }
  }
}, 3000);
function setConn(ok) { const c = $('#conn'); c.textContent = ok ? '● 实时已连接' : '○ 连接中断（轮询兜底）'; c.className = 'conn ' + (ok ? 'ok' : 'bad'); }

// ---------------------------------------------------------------- 渲染

function renderAll() {
  if (!state.snap) return;
  $('#server-clock').textContent = fmtTime(state.snap.serverNow);
  $('#clock-offset').textContent = state.snap.clockOffsetMs;
  $('#last-seq').textContent = state.snap.lastSeq;
  renderSeats();
  renderHandovers();
  renderTakeovers();
  renderUsers();
  renderDenials();
  renderAccepted();
  renderActorPicker();
  renderActorCard();
  populateShiftUsers();
  updateCountdowns();
  restoreFocus();
}

let focusKey = null;
function rememberFocus() {
  const a = document.activeElement;
  focusKey = a?.dataset?.focusKey || null;
}
function restoreFocus() {
  if (!focusKey) return;
  const el = document.querySelector(`[data-focus-key="${focusKey}"]`);
  if (el) { el.focus(); const v = el.value; el.setSelectionRange(v.length, v.length); }
  focusKey = null;
}

function renderSeats() {
  const box = $('#seats');
  box.textContent = '';
  $('#seats-hint').textContent = `共 ${state.snap.seats.length} 个席位 · 租约 TTL 见进度条`;
  for (const s of state.snap.seats) {
    const mine = state.me === s.holderId;
    const card = h('div', { class: `seat ${s.status}`, dataset: { seatId: s.id } }, [
      h('div', { class: 'row' }, [
        h('span', { class: `name kind-${s.kind}` }, `${KIND_ICON[s.kind]} ${s.name}`),
        h('span', { class: 'pill ' + s.status }, s.status === 'held' ? '持有中' : s.status === 'expired' ? '已失联过期' : '已交出待生效'),
      ]),
      h('div', { class: 'row meta dim' }, [
        h('span', {}, `持有人：${s.holderName || '—'}`),
        h('span', { class: 'gen' }, 'gen ' + s.generation),
      ]),
      h('div', { class: 'bar' }, [h('i')]),
      h('div', { class: 'row' }, [
        h('span', { class: 'dim' }, '宽限边界倒计时'),
        h('span', { class: 'count' }, '…'),
      ]),
      h('div', { class: 'actions' }, renderSeatButtons(s, mine)),
      mine ? renderConsoleOps(s) : null,
    ]);
    box.append(card);
  }
}

function renderSeatButtons(s, mine) {
  const btns = [];
  if (mine) {
    btns.push(h('button', { class: 'small ghost', dataset: { action: 'heartbeat', seatId: s.id, gen: s.generation } }, '💓 心跳续租'));
    btns.push(h('button', { class: 'small', dataset: { action: 'goto-start-handover', seatId: s.id } }, '🤝 发起交班'));
  } else if (s.status === 'expired' && state.me) {
    btns.push(h('button', { class: 'small warn', dataset: { action: 'open-takeover', seatId: s.id, gen: s.generation } }, '🚨 申请紧急接管'));
  }
  return btns;
}

/** 当前持有人控制台：业务写操作 + 指纹/世代实验 */
function renderConsoleOps(s) {
  const f = formOf(s.id);
  if (f.gen > s.generation) f.gen = s.generation;
  const payloadInput = h('textarea', { rows: '3', style: 'width:100%;font-family:var(--mono);font-size:12px;', dataset: { focusKey: `payload-${s.id}` } }, []);
  payloadInput.value = f.payload;
  payloadInput.addEventListener('input', () => { f.payload = payloadInput.value; });
  const fpInput = h('input', { style: 'flex:2;font-family:var(--mono);font-size:11px;', dataset: { focusKey: `fp-${s.id}` } });
  fpInput.value = f.fp;
  fpInput.addEventListener('input', () => { f.fp = fpInput.value; });
  const genSel = h('select');
  for (let g = 1; g <= s.generation; g++) genInputAppend(genSel, g);
  genSel.value = String(f.gen);
  genSel.addEventListener('change', () => { f.gen = Number(genSel.value); });
  const autoCb = h('input', { type: 'checkbox' });
  autoCb.checked = f.autoHb;
  autoCb.addEventListener('change', () => { f.autoHb = autoCb.checked; toggleAutoHeartbeat(s.id); });

  return h('div', { class: 'seat-ops' }, [
    h('div', { class: 'dim' }, `业务写操作（席位类型：${OP_LABEL[s.kind]}）`),
    payloadInput,
    h('div', { class: 'line' }, [
      fpInput,
      h('button', { class: 'small ghost', dataset: { action: 'new-fp', seatId: s.id } }, '换新指纹'),
    ]),
    h('div', { class: 'line' }, [
      h('span', { class: 'dim' }, '携带世代'), genSel,
      h('label', { class: 'chk' }, [autoCb, '自动心跳(7s)']),
    ]),
    h('div', { class: 'line' }, [
      h('button', { class: '', dataset: { action: 'biz', seatId: s.id, op: s.kind } }, '执行业务'),
      h('button', { class: 'small ghost', dataset: { action: 'mutate-payload', seatId: s.id } }, '微改载荷（指纹不变→应被拒）'),
    ]),
    h('div', { class: 'dim' }, '提示：同一指纹不变再点“执行业务”=相同重试（返回原判定）；改内容不换指纹=复用冲突（拒绝）。'),
  ]);
}
function genInputAppend(sel, g) { sel.append(h('option', { value: g }, 'gen ' + g)); }

function renderHandovers() {
  const box = $('#handovers');
  box.textContent = '';
  const list = state.snap.handovers.filter((x) => x.status === 'pending' || x.status === 'superseded');
  if (!list.length) return box.append(h('div', { class: 'empty' }, '暂无交接。持有人在席位卡上发起交班。'));
  for (const hv of list) {
    const s = state.snap.seats.find((x) => x.id === hv.seatId);
    const rows = [
      h('div', { class: 'row' }, [
        h('b', {}, `${hv.seatName}（gen ${hv.gen}）`),
        h('span', { class: 'pill ' + (hv.status === 'pending' ? 'surrendering' : 'expired') }, hv.status === 'pending' ? '待确认' : '已被新世代取代'),
      ]),
      h('div', { class: 'meta dim' }, `${hv.fromUserName} → ${hv.toUserName}`),
      h('div', { class: 'wlist' }, [
        h('span', { class: 'wchip' + (hv.successorConfirmed ? '' : ' need') }, hv.successorConfirmed ? '✓ 接班人已确认' : '○ 待接班人确认'),
        h('span', { class: 'wchip' + (hv.holderReleased ? '' : ' need') }, hv.holderReleased ? '✓ 持有人已交出' : '○ 待持有人交出'),
      ]),
    ];
    if (hv.status === 'pending' && s && s.generation === hv.gen) {
      const acts = h('div', { class: 'actions' }, []);
      if (state.me === hv.toUserId) acts.append(h('button', { class: 'small', dataset: { action: 'ho-confirm', id: hv.id } }, hv.successorConfirmed ? '确认（已确认）' : '接班人：确认接班'));
      if (state.me === hv.fromHolderId) acts.append(h('button', { class: 'small', dataset: { action: 'ho-release', id: hv.id } }, hv.holderReleased ? '已交出' : '持有人：交出席位'));
      if (state.me === hv.toUserId || state.me === hv.fromHolderId) acts.append(h('button', { class: 'small ghost', dataset: { action: 'ho-cancel', id: hv.id } }, '取消交接'));
      rows.push(acts);
      rows.push(h('div', { class: 'status-line' + (hv.successorConfirmed && hv.holderReleased ? ' ok' : '') },
        hv.successorConfirmed && hv.holderReleased ? '两步齐备，正在原子切换新世代…' : '两步都完成后新世代才生效；旧控制台此后的写操作会被围栏拒绝。'));
    }
    box.append(h('div', { class: 'card' }, rows));
  }
}

function renderTakeovers() {
  const box = $('#takeovers');
  box.textContent = '';
  const open = state.snap.takeovers.filter((t) => t.status === 'open' || t.status === 'superseded');
  if (!open.length) return box.append(h('div', { class: 'empty' }, '暂无紧急接管申请。租约过期后非持有人可申请，两名合格见证人见证后夺取（世代 +1）。'));
  for (const t of open) {
    const body = [
      h('div', { class: 'row' }, [
        h('b', {}, `🚨 ${t.seatName}（基于 gen ${t.gen}）`),
        h('span', { class: 'pill ' + (t.status === 'open' ? 'surrendering' : 'expired') }, t.status === 'open' ? (t.leaseActive ? '租约未到期·过早' : '见证收集中') : '已作废（席位已有归属）'),
      ]),
      h('div', { class: 'meta dim' }, `申请人：${t.claimantName}`),
      h('div', { class: 'wlist' }, [0, 1].map((i) => h('span', { class: 'wchip' + (t.witnesses[i] ? '' : ' need') }, t.witnesses[i] ? '✓ ' + t.witnessNames[i] : '○ 第 ' + (i + 1) + ' 名合格见证人'))),
    ];
    if (t.status === 'open') {
      if (t.leaseActive) body.push(h('div', { class: 'status-line' }, '原持有人失联未达门槛：见证会被拒绝。可点演示工具“快进 +25 秒”。'));
      const acts = h('div', { class: 'actions' }, []);
      if (state.me && state.me !== t.claimantId) {
        acts.append(h('button', { class: 'small ' + (isMeQualified() ? '' : 'ghost'), dataset: { action: 'tk-attest', id: t.id } },
          t.witnesses.includes(state.me) ? '已见证（重复见证无效）' : '作为见证人签名'));
      }
      body.push(acts);
    }
    box.append(h('div', { class: 'card' }, body));
  }
}
function isMeQualified() {
  return state.snap.users.find((u) => u.id === state.me)?.witnessQualified;
}

function renderUsers() {
  const box = $('#users');
  box.textContent = '';
  for (const u of state.snap.users) {
    const me = u.id === state.me;
    box.append(h('div', { class: 'logrow' }, [
      h('span', {}, [u.name, me ? h('b', { style: 'color:var(--accent)' }, '（本机身份）') : null, h('div', { class: 'fp' }, u.role)]),
      h('span', { style: 'display:flex;gap:6px;align-items:center' }, [
        h('span', { class: 'pill ' + (u.witnessQualified ? 'held' : 'expired') }, u.witnessQualified ? '见证合格' : '无资格'),
        h('button', { class: 'small ghost', dataset: { action: 'toggle-witness', id: u.id, q: u.witnessQualified ? 0 : 1 } }, u.witnessQualified ? '撤销资格' : '授予资格'),
      ]),
    ]));
  }
}

function renderDenials() {
  const box = $('#denials');
  box.textContent = '';
  if (!state.snap.denials.length) return box.append(h('div', { class: 'empty' }, '暂无被围栏拒绝的操作。'));
  for (const d of state.snap.denials.slice(0, 30)) {
    box.append(h('div', { class: 'logrow' }, [
      h('span', {}, [
        h('div', {}, `${OP_LABEL[d.op] || d.op} @ ${d.seatId} gen ${d.generation} by ${d.holderId}`),
        h('div', { class: 'fp' }, d.fingerprint),
      ]),
      h('span', { style: 'text-align:right' }, [
        h('div', { class: 'reason' }, '⛔ ' + d.reason),
        h('div', { class: 'fp' }, fmtTime(d.ts)),
      ]),
    ]));
  }
}

function renderAccepted() {
  const box = $('#accepted');
  box.textContent = '';
  if (!state.snap.accepted.length) return box.append(h('div', { class: 'empty' }, '尚无已接受请求。'));
  for (const v of state.snap.accepted.slice(0, 30)) {
    box.append(h('div', { class: 'logrow' }, [
      h('span', {}, [
        h('div', {}, `${OP_LABEL[v.op]} @ ${v.seatId} gen ${v.generation}`),
        h('div', { class: 'fp' }, v.result?.message || ''),
        h('div', { class: 'fp' }, v.fingerprint),
      ]),
      h('span', { style: 'text-align:right' }, [
        h('div', { class: 'ok-r' }, '✓ ' + (v.result?.ok ? '成功' : '业务失败(原判定)')),
        h('div', { class: 'fp' }, fmtTime(v.ts)),
      ]),
    ]));
  }
}

function renderActorPicker() {
  const box = $('#actor-picker');
  if (box.dataset.dirty === '1') return; // 正在渲染自身，避免递归
  box.dataset.dirty = '1';
  box.textContent = '';
  for (const u of state.snap.users) {
    box.append(h('button', {
      class: u.id === state.me ? 'me' : '',
      dataset: { action: 'switch-me', id: u.id },
    }, u.name));
  }
  if (state.me) box.append(h('button', { class: 'ghost', dataset: { action: 'switch-me', id: '' } }, '未登录'));
  box.dataset.dirty = '0';
}

function renderActorCard() {
  const box = $('#actor-card');
  box.textContent = '';
  if (!state.me) return box.append(h('div', { class: 'empty' }, '请选择一个模拟身份。可多开标签页选不同身份模拟多控制台。'));
  const u = state.snap.users.find((x) => x.id === state.me);
  const mine = state.snap.seats.filter((s) => s.holderId === state.me);
  box.append(h('div', { class: 'card' }, [
    h('b', {}, u.name),
    h('div', { class: 'meta dim' }, `${u.role} · ${u.witnessQualified ? '具备见证资格' : '无见证资格'}`),
    h('div', { class: 'meta dim' }, mine.length ? '持有席位：' + mine.map((s) => `${s.name}(gen ${s.generation})`).join('，') : '当前不持有任何席位（可查看状态、接班、见证或在过期后接管）'),
  ]));
}

function populateShiftUsers() {
  const sel = $('#ns-holder');
  if (sel.dataset.filled === '1') return;
  for (const u of state.snap.users) sel.append(h('option', { value: u.id }, u.name));
  sel.dataset.filled = '1';
}

// ---------------------------------------------------------------- 倒计时（本地高频刷新，不碰输入框）

function updateCountdowns() {
  if (!state.snap) return;
  const now = approxNow();
  for (const card of document.querySelectorAll('.seat')) {
    const s = state.snap.seats.find((x) => x.id === card.dataset.seatId);
    if (!s) continue;
    const remain = Math.max(0, s.expiresAt - now);
    const pct = Math.min(100, (remain / s.ttlMs) * 100);
    const bar = card.querySelector('.bar');
    bar.firstElementChild.style.width = pct + '%';
    bar.className = 'bar' + (remain === 0 ? ' bad' : remain < 7000 ? ' warn' : '');
    const count = card.querySelector('.count');
    count.textContent = remain === 0 ? '已过期' : (remain / 1000).toFixed(1) + 's';
    count.className = 'count' + (remain === 0 ? ' dead' : remain < 7000 ? ' soon' : '');
  }
}
setInterval(updateCountdowns, 250);

// ---------------------------------------------------------------- 自动心跳

function toggleAutoHeartbeat(seatId) {
  const f = formOf(seatId);
  clearInterval(state.hbTimers[seatId]);
  delete state.hbTimers[seatId];
  if (!f.autoHb) return;
  const beat = async () => {
    const s = state.snap?.seats.find((x) => x.id === seatId);
    if (!s || s.holderId !== state.me) { f.autoHb = false; return toggleAutoHeartbeat(seatId); }
    const r = await api('/api/heartbeat', { seatId, generation: s.generation });
    if (!r) { toast('心跳被拒（可能已交班/过期），自动续租停止', 'err'); f.autoHb = false; renderAll(); toggleAutoHeartbeat(seatId); }
  };
  state.hbTimers[seatId] = setInterval(beat, 7000);
}

// ---------------------------------------------------------------- 业务执行

async function runBusiness(seatId, op) {
  const s = state.snap.seats.find((x) => x.id === seatId);
  const f = formOf(seatId);
  let payload;
  try { payload = JSON.parse(f.payload); } catch { return toast('❌ 载荷不是合法 JSON', 'err'); }
  rememberFocus();
  const r = await api('/api/adapter/evaluate', {
    seatId, generation: f.gen, op, payload,
    payloadHash: null, fingerprint: f.fp,
  });
  if (!r) return;
  if (r.decision === 'ACCEPT') toast(`✓ 接受：${r.verdict.message || ''}`, 'ok');
  else if (r.decision === 'ACCEPT_REPLAY') toast(`↩ 相同重试，返回原判定：${r.verdict?.message || ''}`, 'ok');
  else toast(`⛔ 拒绝：${r.reason} ${r.detail || ''}`, 'err');
  // 一次实验后默认换新指纹，避免误伤后续操作；需要重放时不要点“换新指纹”
}

// ---------------------------------------------------------------- 事件委托

document.body.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const a = b.dataset.action;
  if (!a) return;
  rememberFocus();
  switch (a) {
    case 'switch-me':
      state.me = b.dataset.id || null;
      localStorage.setItem('duty.me', state.me || '');
      renderAll();
      break;
    case 'new-fp': {
      const f = formOf(b.dataset.seatId); f.fp = newFp(); renderAll(); break;
    }
    case 'mutate-payload': {
      const f = formOf(b.dataset.seatId);
      try {
        const obj = JSON.parse(f.payload);
        if (Array.isArray(obj.zones)) obj.zones.push('X-' + Math.floor(Math.random() * 99));
        else if ('vehicleCount' in obj) obj.vehicleCount = Number(obj.vehicleCount) + 1;
        else if (obj.target) obj.target = obj.target + '（被篡改）';
        else obj._t = Date.now();
        f.payload = JSON.stringify(obj);
        renderAll();
        toast('载荷已修改但指纹保留：点“执行业务”应收到 FINGERPRINT_REUSED', 'ok');
      } catch { toast('载荷不是合法 JSON，无法微改', 'err'); }
      break;
    }
    case 'heartbeat':
      await api('/api/heartbeat', { seatId: b.dataset.seatId, generation: Number(b.dataset.gen) });
      break;
    case 'goto-start-handover': {
      const uid = prompt('交接给哪位接班人？输入用户 ID（如 u-su）', 'u-su');
      if (uid) await api('/api/handover/start', { seatId: b.dataset.seatId, toUserId: uid.trim() });
      break;
    }
    case 'ho-confirm': await api('/api/handover/confirm', { handoverId: b.dataset.id }); break;
    case 'ho-release': await api('/api/handover/release', { handoverId: b.dataset.id }); break;
    case 'ho-cancel': await api('/api/handover/cancel', { handoverId: b.dataset.id, reason: '控制台取消' }); break;
    case 'open-takeover': await api('/api/takeover/open', { seatId: b.dataset.seatId, expectedGeneration: Number(b.dataset.gen) }); break;
    case 'tk-attest': await api('/api/takeover/attest', { takeoverId: b.dataset.id }); break;
    case 'biz': await runBusiness(b.dataset.seatId, b.dataset.op); break;
    case 'toggle-witness':
      await api('/api/witness-qualification', { userId: b.dataset.id, qualified: b.dataset.q === '1' });
      break;
    default: break;
  }
});

// ---------------------------------------------------------------- 顶部操作

$('#ns-create').addEventListener('click', async () => {
  const name = $('#ns-name').value.trim();
  const seatName = $('#ns-seat').value.trim();
  const kind = $('#ns-kind').value;
  const holderId = $('#ns-holder').value;
  const ttlMs = Number($('#ns-ttl').value) || 20000;
  if (!name || !seatName) return toast('请填写班次与席位名称', 'err');
  await api('/api/shifts', { name, seats: [{ name: seatName, kind, holderId, ttlMs }] });
  $('#ns-name').value = ''; $('#ns-seat').value = '';
});

$('#btn-ff').addEventListener('click', async () => {
  await api('/api/dev/clock', { offsetMs: (state.snap?.clockOffsetMs || 0) + 25000 });
  toast('逻辑时钟快进 25 秒：所有席位越过宽限边界', 'ok');
});
$('#btn-reset-clock').addEventListener('click', () => api('/api/dev/clock', { offsetMs: 0 }));
$('#btn-crash').addEventListener('click', async () => {
  if (!confirm('立即杀死服务进程（SIGKILL）。容器若带 --restart 会自动拉起，可观察恢复。继续？')) return;
  try { await fetch('/api/dev/crash', { method: 'POST' }); } catch { /* 进程已死，连接被重置，属预期 */ }
  toast('进程已崩溃，等待自动重启…', 'err');
});
$('#btn-reset-data').addEventListener('click', async () => {
  if (!confirm('清空事件日志并重建演示数据？世代将从 1 重新开始。')) return;
  await api('/api/dev/reset', {});
  toast('演示数据已重置', 'ok');
});
