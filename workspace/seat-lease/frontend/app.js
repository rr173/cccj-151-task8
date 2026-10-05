/* 值班席位租约协调器 —— 管理页面（原生 JS，无依赖）。
 * 控制台卡片在 localStorage 持久化，刷新页面后可继续“旧世代控制台”实验。 */
"use strict";

const API = "";
let STATE = null;
let consoles = loadConsoles();

function loadConsoles() {
  try { return JSON.parse(localStorage.getItem("sl_consoles") || "[]"); }
  catch { return []; }
}
function saveConsoles() {
  localStorage.setItem("sl_consoles", JSON.stringify(consoles));
}
function uid() { return "c" + Math.random().toString(36).slice(2, 9); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fmt(ms) {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false }) +
    "." + String(ms % 1000).padStart(3, "0").slice(0, 3);
}
async function api(path, body) {
  const resp = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json();
  if (!resp.ok || data.ok === false) {
    const e = new Error(data.message || resp.statusText);
    e.code = data.error; e.detail = data.detail; e.status = resp.status;
    throw e;
  }
  return data;
}
async function refresh() {
  const resp = await fetch(API + "/api/state");
  STATE = (await resp.json()).state;
  renderAll();
}

/* ------------------------------------------------------------- 控制台 */

function addConsole() {
  const first = STATE.people.find(p => true);
  consoles.push({
    id: uid(), person: first ? first.id : "",
    seat: STATE.seats[0] ? STATE.seats[0].id : "",
    online: true, autohb: true, stale: false, gen: null,
    lastFp: null,
  });
  saveConsoles();
  renderAll();
}

function cupdate(id, patch) {
  const c = consoles.find(x => x.id === id);
  Object.assign(c, patch);
  // 切换席位/人员时把世代对齐当前值（之后只有本人仍是持有人才会自动跟随）
  if (("seat" in patch || "person" in patch)) {
    const seat = STATE.seats.find(s => s.id === c.seat);
    c.gen = seat ? seat.generation : null;
  }
  if ("stale" in patch && !patch.stale) {
    const seat = STATE.seats.find(s => s.id === c.seat);
    if (seat && seat.holder_id === c.person) c.gen = seat.generation;
  }
  saveConsoles();
  renderAll();
}

function consoleGen(c, seat) {
  if (c.gen == null) return seat ? seat.generation : 0;
  return c.gen;
}

function setResult(card, ok, text) {
  const box = card.querySelector('[data-role="result"]');
  box.className = "console-result " + (ok ? "ok" : "err");
  box.textContent = text;
}

/* 每个在线控制台自动心跳（仅当本人是当前持有人、世代一致且非旧世代模式） */
setInterval(() => {
  if (!STATE) return;
  for (const c of consoles) {
    if (!c.online || !c.autohb) continue;
    const seat = STATE.seats.find(s => s.id === c.seat);
    if (!seat || seat.holder_id !== c.person) continue;
    const gen = consoleGen(c, seat);
    if (c.stale || gen !== seat.generation) continue;
    if (seat.phase !== "ACTIVE") continue;
    api("/api/seats/heartbeat", {
      seat: seat.id, actor_id: c.person, generation: gen,
    }).catch(() => {});
  }
}, 4000);

async function consoleAction(id, action, ev) {
  const c = consoles.find(x => x.id === id);
  const card = ev.target.closest("[data-console]");
  const val = role => card.querySelector(`[data-role="${role}"]`).value;
  const seatId = val("seat");
  try {
    let out;
    if (action === "heartbeat") {
      out = await api("/api/seats/heartbeat", {
        seat: seatId, actor_id: c.person, generation: consoleGen(c, STATE.seats.find(s => s.id === seatId)),
      });
    } else if (action === "propose") {
      out = await api("/api/handovers", {
        seat: seatId, actor_id: c.person, successor_id: val("successor"),
      });
      setResult(card, true, "交接已发起，等待接班人确认与本人交出");
    } else if (action === "confirm") {
      const h = STATE.pending_handovers.find(x => x.seat === seatId && x.to_holder_id === c.person)
        || STATE.pending_handovers.find(x => x.seat === seatId && x.status === "pending");
      if (!h) throw { message: "没有待确认的交接" };
      out = await api("/api/handovers/confirm", { handover_id: h.id, actor_id: c.person });
      setResult(card, true, out.handover.holder_released
        ? `✅ 两阶段完成，新世代 ${out.handover.generation} 生效`
        : "已确认，等待当前持有人交出");
    } else if (action === "release") {
      const h = STATE.pending_handovers.find(x => x.seat === seatId && x.from_holder_id === c.person)
        || STATE.pending_handovers.find(x => x.seat === seatId && x.status === "pending");
      if (!h) throw { message: "没有待交出的交接" };
      out = await api("/api/handovers/release", { handover_id: h.id, actor_id: c.person });
      setResult(card, true, out.handover.successor_confirmed
        ? `✅ 两阶段完成，新世代 ${out.handover.generation} 生效，本控制台已属旧世代`
        : "已交出，等待接班人确认；在提交完成前你仍是持有人");
    } else if (action === "start-takeover") {
      out = await api("/api/takeovers", {
        seat: seatId, claimant_id: c.person, witness_ids: [],
      });
      setResult(card, true, `接管申请 ${out.takeover.id} 已发起，等待两名合格见证人见证`);
    } else if (action === "attest") {
      const tk = STATE.active_takeovers.find(x => x.seat === seatId);
      if (!tk) throw { message: "该席位没有进行中的接管申请" };
      out = await api("/api/takeovers/attest", { takeover_id: tk.id, witness_id: c.person });
      setResult(card, true, `见证已登记（当前有效见证人 ${out.takeover.valid_witness_count}）`);
    } else if (action === "finalize") {
      const tk = STATE.active_takeovers.find(x => x.seat === seatId);
      if (!tk) throw { message: "该席位没有进行中的接管申请" };
      out = await api("/api/takeovers/finalize", { takeover_id: tk.id, actor_id: c.person });
      setResult(card, true, `🏁 接管成功，席位进入世代 ${out.takeover.generation}`);
    } else if (action === "write" || action === "retry" || action === "reuse-fp") {
      let payload = JSON.parse(card.querySelector('[data-role="payload"]').value || "{}");
      let fp = val("fp") || c.lastFp;
      if (action === "write") {
        if (!val("fp")) fp = "fp-" + uid() + "-" + Date.now().toString(36);
        payload = JSON.parse(card.querySelector('[data-role="payload"]').value || "{}");
      }
      if (action === "reuse-fp") {
        if (!fp) throw { message: "请先执行一次写操作产生指纹" };
        payload = JSON.parse(JSON.stringify(payload));
        payload.__tamper = "指纹复用测试 " + Date.now();
      }
      const verdict = await api("/api/fence/decide", {
        seat: seatId, generation: consoleGen(c, STATE.seats.find(s => s.id === seatId)),
        fingerprint: fp, actor_id: c.person, op: val("op"), payload,
      });
      c.lastFp = fp;
      card.querySelector('[data-role="fp"]').value = fp;
      saveConsoles();
      const v = verdict.verdict;
      setResult(card, true,
        `${v.replay ? "🔁 原判定回放" : "✅ 已接受"}：${v.response.op} → ${v.response.reference}\n` +
        `世代 ${v.generation} · 指纹 ${v.fingerprint.slice(0, 18)}…`);
      out = verdict;
    }
    if (out && !card.querySelector('[data-role="result"]').textContent) {
      setResult(card, true, JSON.stringify(out, null, 2));
    }
    await refresh();
  } catch (e) {
    setResult(card, false, `⛔ ${e.code || "ERROR"}: ${e.message}` +
      (e.detail && Object.keys(e.detail).length ? "\n" + JSON.stringify(e.detail) : ""));
  }
}

/* ------------------------------------------------------------- 渲染 */

function fillPeople(select, keepVal) {
  const cur = keepVal ? select.value : null;
  select.innerHTML = STATE.people.map(p =>
    `<option value="${esc(p.id)}">${esc(p.name)}${p.witness_qualified ? " 🛡️" : ""}</option>`).join("");
  if (cur && STATE.people.some(p => p.id === cur)) select.value = cur;
}
function fillSeats(select, keepVal) {
  const cur = keepVal ? select.value : null;
  select.innerHTML = STATE.seats.map(s =>
    `<option value="${esc(s.id)}">${esc(s.id)}（${esc(s.holder_name || "空缺")} · g${s.generation}）</option>`).join("");
  if (cur && STATE.seats.some(s => s.id === cur)) select.value = cur;
}

function renderConsoles() {
  const wrap = document.getElementById("consoles");
  const tpl = document.getElementById("tpl-console");
  // 简单做法：全量重渲染（输入焦点场景可接受，控件多为下拉/按钮）
  wrap.innerHTML = "";
  for (const c of consoles) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = c.id;
    const seat = STATE.seats.find(s => s.id === c.seat);

    // 世代自动跟随：本人仍是当前持有人且未启用旧世代模式
    if (seat && !c.stale && seat.holder_id === c.person &&
        (c.gen == null || c.gen < seat.generation)) {
      c.gen = seat.generation;
    }
    if (seat && c.gen == null) c.gen = seat.generation;

    const personSel = node.querySelector('[data-role="person"]');
    fillPeople(personSel, true); personSel.value = c.person;
    const seatSel = node.querySelector('[data-role="seat"]');
    fillSeats(seatSel, true); seatSel.value = c.seat;
    fillPeople(node.querySelector('[data-role="successor"]'), false);

    node.querySelector('[data-role="online"]').checked = c.online;
    node.querySelector('[data-role="autohb"]').checked = c.autohb;
    node.querySelector('[data-role="usegen"]').checked = c.stale;
    node.querySelector('[data-role="gen"]').textContent = consoleGen(c, seat);
    node.querySelector('[data-role="fp"]').value = c.lastFp || "";

    const dot = node.querySelector('[data-role="dot"]');
    node.classList.toggle("offline", !c.online);
    const isStale = seat && (c.stale || consoleGen(c, seat) !== seat.generation ||
      seat.holder_id !== c.person);
    node.classList.toggle("stale", !!isStale && c.online);
    dot.className = "conn-dot" + (!c.online ? " offline" : isStale ? " stale" : "");

    node.querySelector('[data-role="person"]').onchange = e => cupdate(c.id, { person: e.target.value });
    node.querySelector('[data-role="seat"]').onchange = e => cupdate(c.id, { seat: e.target.value });
    node.querySelector('[data-role="online"]').onchange = e => cupdate(c.id, { online: e.target.checked });
    node.querySelector('[data-role="autohb"]').onchange = e => cupdate(c.id, { autohb: e.target.checked });
    node.querySelector('[data-role="usegen"]').onchange = e => cupdate(c.id, { stale: e.target.checked });
    node.querySelector('[data-role="remove"]').onclick = () => {
      consoles = consoles.filter(x => x.id !== c.id); saveConsoles(); renderAll();
    };
    node.querySelectorAll("[data-action]").forEach(btn => {
      btn.onclick = ev => consoleAction(c.id, btn.dataset.action, ev);
    });
    wrap.appendChild(node);
  }
  saveConsoles();
}

function renderSeats() {
  document.getElementById("seats").innerHTML = STATE.seats.map(s => {
    const total = s.ttl_ms + s.grace_ms;
    let pct, cls;
    if (s.phase === "ACTIVE") { pct = 100 * (s.ms_to_expiry / s.ttl_ms); cls = ""; }
    else if (s.phase === "GRACE") { pct = 100 * (s.ms_to_grace_end / total); cls = "grace"; }
    else { pct = 100; cls = "expired"; }
    const pend = STATE.pending_handovers.find(h => h.seat === s.id);
    return `<div class="seat-card">
      <div class="seat-top">
        <span><span class="seat-id">${esc(s.id)}</span>
          <span class="muted"> · 世代 g${s.generation}</span>
          ${pend ? ` · <span class="muted">交接中 → ${esc(pend.to_holder_name)}</span>` : ""}</span>
        <span class="phase ${s.phase}">${s.phase}</span>
      </div>
      <div>持有人：<span class="seat-holder">${esc(s.holder_name || "空缺")}</span></div>
      <div class="countdown ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="seat-meta">
        <span>租期剩余：${s.ms_to_expiry != null ? (s.ms_to_expiry / 1000).toFixed(1) + "s" : "—"}</span>
        <span>宽限边界：${s.ms_to_grace_end != null ? (s.ms_to_grace_end / 1000).toFixed(1) + "s" : "—"}</span>
        <span>TTL ${s.ttl_ms}ms + 宽限 ${s.grace_ms}ms</span>
        <span>${s.writable ? "✅ 可写" : "⛔ 写已封锁"}</span>
      </div>
    </div>`;
  }).join("") || `<p class="muted">暂无席位</p>`;
}

function renderHandovers() {
  const hs = STATE.handovers;
  document.getElementById("handovers").innerHTML = (hs.length ? hs : []).map(h => {
    const cls = h.status === "committed" ? "committed" :
      h.status === "cancelled" ? "cancelled" : h.status === "superseded" ? "superseded" : "";
    const statusText = { pending: "进行中", committed: "✅ 已提交新世代",
      cancelled: "已取消", superseded: "已被接管取代" }[h.status];
    return `<div class="flow-card ${cls}">
      <div><b>${esc(h.seat)}</b>：${esc(h.from_holder_name)}（g${h.from_generation}）
        → ${esc(h.to_holder_name)} <span class="muted">[${esc(statusText)}${h.generation ? `，g${h.generation}` : ""}]</span></div>
      <div class="flow-steps">
        <div class="step ${h.successor_confirmed ? "done" : ""}">1. 接班人确认</div>
        <div class="step ${h.holder_released ? "done" : ""}">2. 当前持有人交出</div>
        <div class="step commit ${h.status === "committed" ? "done" : ""}">3. 新世代原子生效</div>
      </div>
      ${h.status === "pending" ? `<div class="muted">${h.ready_to_commit ? "两步齐备，下次动作即提交" :
        "两步都完成后才提交；任何一步前崩溃，旧持有人在旧世代仍有效"}</div>` : ""}
    </div>`;
  }).join("") || `<p class="muted">暂无交接记录</p>`;
}

async function witnessAttest(tkId, pid) {
  try { await api("/api/takeovers/attest", { takeover_id: tkId, witness_id: pid }); }
  catch (e) { alert("见证被拒：" + e.message); }
  refresh();
}
async function doFinalize(tkId) {
  try {
    const out = await api("/api/takeovers/finalize", { takeover_id: tkId, actor_id: "system" });
    alert(`接管成功：${out.takeover.seat} 进入 g${out.takeover.generation}`);
  } catch (e) { alert("夺取被拒：" + e.message); }
  refresh();
}

function renderTakeovers() {
  document.getElementById("takeovers").innerHTML =
    STATE.takeovers.map(tk => {
      const cls = tk.status === "won" ? "won" :
        tk.status === "superseded" ? "superseded" : "";
      const qualified = STATE.people.filter(p => p.witness_qualified);
      const chips = tk.witness_views.map(w =>
        `<span class="witness-chip ${w.qualified_now ? "ok" : "bad"}">${esc(w.name)}${w.qualified_now ? " ✓资格" : " ✗资格已变"}</span>`).join("");
      return `<div class="flow-card ${cls}">
        <div><b>${esc(tk.seat)}</b>：${esc(tk.claimant_name)} 申请接管
          <span class="muted">（原 g${tk.from_generation}）[${
            { witnessing: "见证中", won: `🏁 已夺取 g${tk.generation}`, superseded: "竞争失败/已失效" }[tk.status]}]</span></div>
        <div>${chips || '<span class="muted">尚无见证人</span>'}
          <span class="muted"> · 有效见证人 ${tk.valid_witness_count}/2</span></div>
        ${tk.status === "witnessing" ? `
          <div class="muted" style="margin-top:6px">
            租约阶段：<b>${esc(tk.lease_phase)}</b>；
            ${tk.lease_phase === "EXPIRED" ? "已过失联门槛，可夺取"
              : `距可夺取 ${(tk.ms_to_grace_end / 1000).toFixed(1)}s`}
          </div>
          <div class="console-row wrap" style="margin-top:6px">
            ${qualified.map(p => `<button class="btn tiny" data-wit="${tk.id}|${esc(p.id)}">${esc(p.name)} 见证</button>`).join("")}
            <button class="btn tiny danger" data-fin="${tk.id}"
              ${tk.can_finalize_now ? "" : "title='当前不可夺取'"}>夺取席位</button>
          </div>` : ""}
      </div>`;
    }).join("") || `<p class="muted">暂无接管申请</p>`;

  document.querySelectorAll("[data-wit]").forEach(b => {
    b.onclick = () => {
      const [tkId, pid] = b.dataset.wit.split("|");
      witnessAttest(tkId, pid);
    };
  });
  document.querySelectorAll("[data-fin]").forEach(b => {
    b.onclick = () => doFinalize(b.dataset.fin);
  });
}

function renderLogs() {
  document.getElementById("effect-count").textContent = STATE.effect_count;
  document.getElementById("effects").innerHTML = STATE.effects.map(v =>
    `<div class="log-item accept"><span class="t">${fmt(v.at)}</span>
      <code>${esc(v.op)}</code> ${esc(v.response?.reference || "")}
      <span class="muted">· ${esc(v.seat)} g${v.generation} by ${esc(v.actor_id)}</span>
      ${v.replay !== undefined ? "" : ""}</div>`).join("") ||
    '<p class="muted">尚无已接受写操作</p>';
  document.getElementById("denials").innerHTML = STATE.denials.map(v =>
    `<div class="log-item deny"><span class="t">${fmt(v.at)}</span>
      <b style="color:var(--red)">${esc(v.reason)}</b>
      ${v.op ? `<code>${esc(v.op)}</code>` : ""}
      <span class="muted">· ${esc(v.seat || "")}${v.generation != null ? " g" + v.generation : ""}${v.actor_id ? " by " + esc(v.actor_id) : ""}</span>
      <div>${esc(v.message || "")}</div></div>`).join("") ||
    '<p class="muted">暂无拒绝记录</p>';
}

async function renderEvents() {
  try {
    const data = await (await fetch(API + "/api/events")).json();
    const evs = data.events.slice(-60).reverse();
    document.getElementById("events").innerHTML = evs.map(e =>
      `<div class="ev-line"><span class="t">${fmt(e.ts)}</span>
        #${e.seq} <span class="ty">${esc(e.type)}</span>
        ${esc(JSON.stringify(e.data)).slice(0, 160)}</div>`).join("");
  } catch { /* 轮询忽略 */ }
}

function renderAdmin() {
  document.getElementById("people-list").innerHTML = STATE.people.map(p =>
    `<div class="person-row"><span>${esc(p.name)}
        <span class="muted">(${esc(p.id)})</span>
        ${p.roles.includes("shift_lead") ? ' <span class="badge">排班</span>' : ""}</span>
      <label class="switch"><input type="checkbox" ${p.witness_qualified ? "checked" : ""}
        data-q="${esc(p.id)}"> 见证资格</label></div>`).join("");
  document.querySelectorAll("[data-q]").forEach(cb => {
    cb.onchange = async () => {
      try { await api("/api/people/witness-qualified", {
        actor_id: cb.dataset.q, person_id: cb.dataset.q, qualified: cb.checked });
      } catch (e) { alert(e.message); }
      refresh();
    };
  });
  document.querySelectorAll("select[data-people]").forEach(s => fillPeople(s, true));
  document.querySelectorAll("select[data-seats]").forEach(s => fillSeats(s, true));

  document.getElementById("shifts").innerHTML = STATE.shifts.map(sh => {
    const leader = STATE.people.find(p => p.id === sh.leader_id);
    const seatIds = STATE.seats.filter(s => s.shift_id === sh.id).map(s => s.id).join("、");
    return `<div class="shift-row">📅 ${esc(sh.name)} · 负责人 ${esc(leader?.name || sh.leader_id)}
      · 席位：${esc(seatIds)}</div>`;
  }).join("");
}

function renderAll() {
  if (!STATE) return;
  renderAdmin();
  renderConsoles();
  renderSeats();
  renderHandovers();
  renderTakeovers();
  renderLogs();
  document.getElementById("server-clock").textContent =
    new Date(STATE.server_time_ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/* ------------------------------------------------------------- 事件绑定 */

document.getElementById("btn-add-console").onclick = addConsole;
document.getElementById("btn-reset").onclick = async () => {
  if (!confirm("清空 WAL 并重置为演示数据？")) return;
  await api("/api/dev/reset", {});
  consoles = []; saveConsoles();
  addConsole();
  await refresh();
};
document.getElementById("btn-snapshot").onclick = async () => {
  const out = await api("/api/dev/snapshot", {});
  alert(`快照已写入 seq=${out.snapshot.snapshot_seq}，WAL 已压缩；重启后从快照+尾部重放`);
};
document.getElementById("form-shift").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const seats = f.seats_text.value.trim().split("\n").map(line => {
    const [id, ttl, grace] = line.split(",").map(x => x.trim());
    return { id, ttl_ms: Number(ttl) || 15000, grace_ms: Number(grace) || 8000 };
  });
  try {
    await api("/api/shifts", { actor_id: f.actor_id.value, name: f.name.value, seats });
    f.name.value = "";
  } catch (err) { alert(err.message); }
  refresh();
};
document.getElementById("form-grant").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("/api/seats/grant", { seat: f.seat.value, holder_id: f.holder_id.value });
  } catch (err) { alert(err.message); }
  refresh();
};

/* 初次加载 */
(async function init() {
  await refresh();
  if (consoles.length === 0) {
    addConsole();
    if (STATE.people.length > 1) {
      // 默认给两个控制台：当前持有人 + 接班人，方便直接演示
      const a = consoles[0];
      a.person = STATE.seats[0].holder_id; a.seat = STATE.seats[0].id;
      a.gen = STATE.seats[0].generation;
      const c2 = { id: uid(), person: "bob", seat: STATE.seats[0].id,
        online: true, autohb: false, stale: false, gen: STATE.seats[0].generation, lastFp: null };
      consoles.push(c2);
      saveConsoles();
    }
  }
  renderAll();
  setInterval(refresh, 1000);
  setInterval(renderEvents, 2000);
})();
