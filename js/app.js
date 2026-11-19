import { OWNER_EMAILS } from "./config.js";

// ===================== Hằng số =====================
const STEPS = [
  { name: "Đào đất",     color: "#908700" },
  { name: "Bê tông lót", color: "#00B0F0" },
  { name: "Cốt thép",    color: "#C00000" },
  { name: "Cốp pha",     color: "#FFC000" },
  { name: "Đổ bê tông",  color: "#00B050" },
  { name: "Lấp đất",     color: "#7030A0" },
];
const NONE_COLOR = "#FFFFFF";
const ROLE_LABEL = { viewer: "Chỉ xem", editor: "Cập nhật", admin: "Quản trị" };
const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

// ===================== Trạng thái =====================
let be = null;            // backend (Firebase)
let P = null;             // dự án hiện tại (data/xxx.json)
let me = null;            // {uid, email, name}
let role = null;          // viewer | editor | admin
let data = {};            // n -> {d:[6], by, byName, at, h:[]}
const sel = new Set();
let multi = false;
let saving = false;
let online = false;
let unsubMong = null, unsubRoles = null;
let lastMsg = null;

const $ = (id) => document.getElementById(id);
const canEdit = () => role === "editor" || role === "admin";
const isAdmin = () => role === "admin";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function todayStr() { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); }
function fmt(s) { if (!s) return ""; const p = s.split("-"); return `${p[2]}/${p[1]}/${p[0]}`; }
function rec(n) { return data[n] || { d: [null, null, null, null, null, null], h: [] }; }
function norm(a) { const o = []; for (let i = 0; i < 6; i++) o.push(a && a[i] ? a[i] : null); return o; }
function level(n, asof) { const d = rec(n).d || []; for (let i = 5; i >= 0; i--) if (d[i] && (!asof || d[i] <= asof)) return i + 1; return 0; }
const colorOf = (l) => (l === 0 ? NONE_COLOR : STEPS[l - 1].color);
function setStatus(t, c) { const s = $("status"); s.textContent = t; s.className = "status " + (c || ""); }

// ===================== Khởi động =====================
const GOOGLE_SVG = '<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function gate(html) { $("gate").hidden = false; $("app").hidden = true; $("gateBody").innerHTML = html; }

function showLogin(err) {
  gate(`<button class="gbtn" id="gLogin">${GOOGLE_SVG}Đăng nhập bằng Google</button>` +
       (err ? `<div class="err">${esc(err)}</div>` : "") +
       `<p class="muted small" style="margin-top:18px">Chỉ tài khoản đã được quản trị viên cấp quyền mới xem được dữ liệu.</p>`);
  $("gLogin").onclick = async () => {
    try { await be.signIn(); }
    catch (e) { showLogin(loginErr(e)); }
  };
}
function loginErr(e) {
  const c = e && e.code || "";
  if (c === "auth/unauthorized-domain") return "Tên miền này chưa được thêm vào Firebase (Authentication → Settings → Authorized domains).";
  if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request") return "";
  if (c === "auth/operation-not-allowed") return "Chưa bật đăng nhập Google trong Firebase Authentication.";
  return "Đăng nhập lỗi: " + (e && e.message || e);
}

async function boot() {
  try {
    P = await (await fetch("data/nsp.json")).json();
  } catch (e) { gate(`<div class="err">Không tải được dữ liệu mặt bằng.</div>`); return; }
  try {
    be = await import("./backend.js");
  } catch (e) { gate(`<div class="err">Không tải được Firebase. Kiểm tra kết nối mạng.<br><small>${esc(e.message)}</small></div>`); return; }

  be.onUser(async (u) => {
    cleanup();
    if (!u) { me = null; role = null; showLogin(); return; }
    me = { uid: u.uid, email: (u.email || "").toLowerCase(), name: u.displayName || u.email };
    gate(`<p class="muted">Đang kiểm tra quyền của <b>${esc(me.email)}</b>…</p>`);
    role = null;
    if (OWNER_EMAILS.map((x) => x.toLowerCase()).includes(me.email)) role = "admin";
    else {
      try { const r = await be.getRole(me.email); role = r && ROLE_LABEL[r.role] ? r.role : null; }
      catch (e) { role = null; }
    }
    if (!role) {
      gate(`<p>Tài khoản <b>${esc(me.email)}</b> chưa được cấp quyền.</p>
            <p class="muted small">Gửi email này cho quản trị viên để được thêm vào danh sách.</p>
            <button id="gOut" style="margin-top:10px">Đăng nhập tài khoản khác</button>`);
      $("gOut").onclick = () => be.signOut();
      return;
    }
    startApp();
  });
}

function cleanup() {
  if (unsubMong) { unsubMong(); unsubMong = null; }
  if (unsubRoles) { unsubRoles(); unsubRoles = null; }
  data = {}; sel.clear(); online = false; lastMsg = null;
}

// ===================== Ứng dụng =====================
let built = false;
function startApp() {
  $("gate").hidden = true; $("app").hidden = false;
  $("pTitle").textContent = P.title; $("pCT").textContent = P.congTrinh; $("pDD").textContent = P.diaDiem;
  document.title = P.title;
  $("userName").textContent = me.name;
  const b = $("roleBadge"); b.textContent = ROLE_LABEL[role]; b.className = "badge " + role;
  $("usersBtn").hidden = !isAdmin();
  document.querySelectorAll(".adm").forEach((e) => (e.hidden = !isAdmin()));
  document.querySelectorAll(".ed").forEach((e) => (e.hidden = !canEdit()));
  if (!built) { buildMap(); bindUI(); built = true; }
  requestAnimationFrame(fit);
  multi = false; $("multiBtn").classList.remove("on");
  paint(); renderPanel();
  setStatus("Đang tải dữ liệu…");
  const timer = setTimeout(() => setStatus("Chưa kết nối được dữ liệu – đang thử lại…", "warn"), 10000);
  unsubMong = be.watchMong(P.id, (d, fromCache) => {
    data = d;
    if (!fromCache) { clearTimeout(timer); online = true; setStatus("Trực tuyến", "ok"); }
    if (!saving) { paint(); renderPanel(); }
  }, (err) => { clearTimeout(timer); setStatus("Lỗi dữ liệu: " + (err.code || err.message), "warn"); });
}

// ---------- Vẽ mặt bằng ----------
const NS = "http://www.w3.org/2000/svg";
const nodes = {};
const vb = { x: 0, y: 0, w: 1, h: 1 };
function setVB() { $("map").setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }

function buildMap() {
  const svg = $("map");
  const img = document.createElementNS(NS, "image");
  img.setAttribute("href", P.image);
  img.setAttribute("x", 0); img.setAttribute("y", 0);
  img.setAttribute("width", P.width); img.setAttribute("height", P.height);
  img.setAttribute("preserveAspectRatio", "none");
  svg.appendChild(img);
  P.geo.forEach(([n, x, y, w, h]) => {
    const g = document.createElementNS(NS, "g"); g.setAttribute("class", "mong"); g.dataset.n = n;
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", h);
    const t = document.createElementNS(NS, "text");
    const cx = x + w / 2, cy = y + h / 2, vert = h > w * 1.4;
    t.setAttribute("x", cx); t.setAttribute("y", cy);
    t.setAttribute("font-size", Math.max(70, Math.min(170, (vert ? w : h) * 0.95)));
    if (vert) t.setAttribute("transform", `rotate(-90 ${cx} ${cy})`);
    t.textContent = n;
    const tt = document.createElementNS(NS, "title");
    g.append(tt, r, t); svg.appendChild(g);
    nodes[n] = { g, r, tt };
  });
  vb.w = P.width; vb.h = P.height; setVB();
  const lg = [`<span><i class="sw" style="background:#fff"></i>Chưa thi công</span>`]
    .concat(STEPS.map((s) => `<span><i class="sw" style="background:${s.color};opacity:.8"></i>${s.name}</span>`));
  $("legend").innerHTML = lg.join("");
}

function paint() {
  const asof = $("asof").value;
  for (const n in nodes) {
    const l = level(n, asof), o = nodes[n];
    o.r.setAttribute("fill", colorOf(l));
    o.r.setAttribute("fill-opacity", l === 0 ? "0.55" : "0.72");
    o.g.classList.toggle("sel", sel.has(n));
    o.tt.textContent = `Móng ${n} – ${l === 0 ? "Chưa thi công" : STEPS[l - 1].name}`;
  }
  renderStats();
}

function stats(asof) {
  const cnt = [0, 0, 0, 0, 0, 0];
  P.geo.forEach((g) => { const l = level(g[0], asof); for (let i = 0; i < l; i++) cnt[i]++; });
  return cnt;
}
function renderStats() {
  const asof = $("asof").value, total = P.geo.length, cnt = stats(asof);
  $("statDate").textContent = fmt(asof);
  let h = `<tr><td>Tổng số móng</td><td>${total}</td></tr>`;
  STEPS.forEach((s, i) => {
    const p = Math.round((cnt[i] / total) * 100);
    h += `<tr><td>${s.name}<div class="bar"><i style="width:${p}%;background:${s.color}"></i></div></td><td>${cnt[i]} (${p}%)</td></tr>`;
  });
  $("stats").innerHTML = h;
}

// ---------- Phóng to / di chuyển ----------
function fit() {
  const r = $("map").getBoundingClientRect(); if (!r.width || !r.height) return;
  const ar = r.width / r.height, iar = P.width / P.height;
  if (ar > iar) { vb.h = P.height; vb.w = P.height * ar; vb.x = -(vb.w - P.width) / 2; vb.y = 0; }
  else { vb.w = P.width; vb.h = P.width / ar; vb.y = -(vb.h - P.height) / 2; vb.x = 0; }
  setVB();
}
function zoomAt(f, cx, cy) {
  const svg = $("map"), r = svg.getBoundingClientRect();
  const nw = vb.w / f; if (nw < P.width / 14 || nw > P.width * 3) return;
  const px = vb.x + ((cx - r.left) / r.width) * vb.w, py = vb.y + ((cy - r.top) / r.height) * vb.h;
  vb.w = nw; vb.h = vb.h / f; vb.x = px - ((cx - r.left) / r.width) * vb.w; vb.y = py - ((cy - r.top) / r.height) * vb.h; setVB();
}
function centerZoom(f) { const r = $("map").getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); }

function bindUI() {
  const svg = $("map");
  $("asof").value = todayStr();
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
  $("zin").onclick = () => centerZoom(1.4);
  $("zout").onclick = () => centerZoom(1 / 1.4);
  $("zfit").onclick = fit;

  const ptrs = new Map(); let moved = false, start = null, pinch = null;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) { moved = false; start = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; }
    if (ptrs.size === 2) { const a = [...ptrs.values()]; pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }; moved = true; }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch) {
      const a = [...ptrs.values()], d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      if (d > 0) { zoomAt(d / pinch.d, (a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2); pinch.d = d; } return;
    }
    if (ptrs.size === 1 && start) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) > 6) { moved = true; svg.classList.add("dragging"); }
      if (moved) { const r = svg.getBoundingClientRect(); vb.x = start.vx - (dx / r.width) * vb.w; vb.y = start.vy - (dy / r.height) * vb.h; setVB(); }
    }
  });
  const endPtr = (e) => {
    const single = ptrs.size === 1; ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (single && !moved && start && e.type === "pointerup") {
      const el = document.elementFromPoint(e.clientX, e.clientY), g = el && el.closest && el.closest(".mong");
      if (g) clickMong(g.dataset.n); else if (!multi) { sel.clear(); paint(); renderPanel(); }
    }
    if (ptrs.size === 0) { start = null; svg.classList.remove("dragging"); }
  };
  svg.addEventListener("pointerup", endPtr); svg.addEventListener("pointercancel", endPtr);

  $("multiBtn").onclick = () => {
    multi = !multi; $("multiBtn").classList.toggle("on", multi);
    if (!multi && sel.size > 1) { const f = [...sel][0]; sel.clear(); sel.add(f); }
    paint(); renderPanel();
  };
  $("clearSel").onclick = () => { sel.clear(); paint(); renderPanel(); };
  $("asof").onchange = paint;
  $("today").onclick = () => { $("asof").value = todayStr(); paint(); };
  $("logoutBtn").onclick = () => be.signOut();
  $("usersBtn").onclick = openUsers;
  $("usersClose").onclick = closeUsers;
  $("usersDlg").onclick = (e) => { if (e.target.id === "usersDlg") closeUsers(); };
  $("addUser").onsubmit = addUser;
  $("impBtn").onclick = () => { $("impFile").value = ""; $("impFile").click(); };
  $("impFile").onchange = importExcel;
  $("expBtn").onclick = exportExcel;
  $("pngBtn").onclick = exportPng;
}

function clickMong(n) {
  if (multi) { sel.has(n) ? sel.delete(n) : sel.add(n); } else { sel.clear(); sel.add(n); }
  paint(); renderPanel();
}

// ---------- Bảng bên phải ----------
function renderPanel() {
  _renderPanel();
  if (lastMsg && Date.now() - lastMsg.t < 5000) { const m = $("msg"); if (m) { m.textContent = lastMsg.text; m.style.color = lastMsg.ok ? "#05603a" : "#b42318"; } }
}
function msg(text, ok) { lastMsg = { text, ok, t: Date.now() }; const m = $("msg"); if (m) { m.textContent = text; m.style.color = ok ? "#05603a" : "#b42318"; } }

function _renderPanel() {
  const panel = $("panel");
  const ro = !canEdit() ? `<div class="note">Bạn có quyền chỉ xem.</div>` : "";
  if (sel.size === 0) {
    const emptyDb = online && Object.keys(data).length === 0;
    panel.innerHTML = `<h2>Chi tiết móng</h2>${ro}` +
      (emptyDb && isAdmin() ? `<div class="note info">Chưa có dữ liệu. Bấm <b>⬆ Nhập từ Excel</b> và chọn file mặt bằng highlight để lấy ngày đã nhập.</div>` : "") +
      `<div class="empty">Bấm vào một móng trên mặt bằng để xem${canEdit() ? " và nhập ngày hoàn thành từng công tác" : " ngày hoàn thành từng công tác"}.` +
      (canEdit() ? `<br><br>Muốn cập nhật cả loạt, bật <b>Chọn nhiều móng</b> rồi bấm lần lượt các móng.` : "") +
      `</div><div class="msg" id="msg"></div>`;
    return;
  }
  if (sel.size === 1 && !multi) return renderSingle([...sel][0], ro);
  renderMulti(ro);
}

function renderSingle(n, ro) {
  const panel = $("panel"), r = rec(n), l = level(n, null), ed = canEdit();
  let h = `<div class="selhead"><b>Móng ${esc(n)}</b><small>${l === 0 ? "Chưa thi công" : "Đã xong: " + STEPS[l - 1].name}</small></div>${ro}<div class="steps">`;
  STEPS.forEach((s, i) => {
    const v = (r.d && r.d[i]) || "";
    h += `<div class="step"><i class="sw" style="background:${s.color};opacity:.8"></i><span>${s.name}</span>` +
      `<input type="date" data-i="${i}" value="${v}"${ed ? "" : " disabled"}>` +
      (ed ? `<button class="x" data-i="${i}" title="Xoá ngày">×</button>` : "<span></span>") + `</div>`;
  });
  h += `</div>`;
  if (ed) h += `<div class="actions"><button class="primary" id="save" disabled>Lưu</button><button id="quick">✓ Xong công tác tiếp theo hôm nay</button></div>`;
  h += `<div class="msg" id="msg"></div>`;
  const hist = (r.h || []).slice().reverse().slice(0, 10);
  if (hist.length) {
    h += `<h2 style="margin-top:14px">Lịch sử</h2><div class="hist">`;
    hist.forEach((e) => {
      h += `<div><b>${esc(e.s)}</b> ${e.d ? fmt(e.d) : "(xoá)"} · ${esc(e.byName || "?")}${e.via ? " (" + esc(e.via) + ")" : ""} · ${new Date(e.at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</div>`;
    });
    h += `</div>`;
  }
  panel.innerHTML = h;
  if (!ed) return;
  const inputs = panel.querySelectorAll("input[type=date]"), saveBtn = $("save");
  const dirty = () => { const cur = r.d || []; let ch = false; inputs.forEach((inp) => { if ((inp.value || null) !== (cur[+inp.dataset.i] || null)) ch = true; }); saveBtn.disabled = !ch; };
  inputs.forEach((inp) => { inp.oninput = dirty; inp.onchange = dirty; });
  panel.querySelectorAll(".x").forEach((b) => { b.onclick = () => { inputs[+b.dataset.i].value = ""; dirty(); }; });
  saveBtn.onclick = () => { const nd = []; inputs.forEach((inp) => (nd[+inp.dataset.i] = inp.value || null)); saveMany([n], () => nd); };
  $("quick").onclick = () => {
    const cur = (r.d || []).slice(), nx = level(n, null);
    if (nx >= 6) { msg("Móng này đã hoàn thành tất cả công tác."); return; }
    cur[nx] = todayStr(); saveMany([n], () => cur);
  };
}

function renderMulti(ro) {
  const panel = $("panel"), list = [...sel].sort((a, b) => a - b);
  let h = `<div class="selhead"><b>${list.length} móng đã chọn</b><small>bấm móng để thêm / bỏ</small></div>${ro}`;
  h += `<div class="multi"><div class="chips">${list.map((n) => `<span>${esc(n)}</span>`).join("")}</div>`;
  if (canEdit()) {
    h += `<label>Công tác <select id="mStep">${STEPS.map((s, i) => `<option value="${i}">${s.name}</option>`).join("")}</select></label>`;
    h += `<label>Ngày hoàn thành <input type="date" id="mDate" value="${todayStr()}"></label>`;
    h += `<div class="actions"><button class="primary" id="mSave">Cập nhật ${list.length} móng</button><button id="mClear">Xoá ngày công tác này</button></div>`;
  }
  h += `<div class="msg" id="msg"></div></div>`;
  panel.innerHTML = h;
  if (!canEdit()) return;
  $("mSave").onclick = () => {
    const i = +$("mStep").value, d = $("mDate").value; if (!d) { msg("Chọn ngày trước."); return; }
    saveMany(list, (n) => { const c = (rec(n).d || []).slice(); c[i] = d; return c; });
  };
  $("mClear").onclick = () => {
    const i = +$("mStep").value;
    saveMany(list, (n) => { const c = (rec(n).d || []).slice(); c[i] = null; return c; });
  };
}

// ---------- Lưu ----------
async function saveMany(list, makeNew, via) {
  if (saving || !canEdit()) return { done: 0 };
  saving = true;
  document.querySelectorAll("#panel button").forEach((b) => (b.disabled = true));
  msg("Đang lưu…", true);
  const now = new Date().toISOString(), entries = [];
  list.forEach((n) => {
    const old = rec(n), od = norm(old.d), nd = norm(makeNew(n));
    if (JSON.stringify(od) === JSON.stringify(nd)) return;
    const h = (old.h || []).slice();
    for (let i = 0; i < 6; i++) if (od[i] !== nd[i]) h.push({ s: STEPS[i].name, d: nd[i], by: me.uid, byName: me.name, at: now, via: via || null });
    entries.push([n, { d: nd, by: me.uid, byName: me.name, at: now, h: h.slice(-30) }]);
  });
  let fail = null;
  try {
    if (entries.length === 1) await be.saveMong(P.id, entries[0][0], entries[0][1]);
    else if (entries.length > 1) await be.saveMongMany(P.id, entries);
    entries.forEach(([n, d]) => (data[n] = d));
  } catch (e) { fail = e; }
  saving = false; paint(); renderPanel();
  if (fail) msg("Không lưu được: " + (fail.code === "permission-denied" ? "không có quyền ghi." : fail.code || fail.message));
  else msg(entries.length ? `Đã lưu ${entries.length} móng.` : "Không có gì thay đổi.", true);
  return { done: fail ? 0 : entries.length, fail };
}

// ---------- Excel ----------
function loadXLSX() {
  return new Promise((res, rej) => {
    if (window.XLSX) return res(window.XLSX);
    const sc = document.createElement("script"); sc.src = XLSX_URL;
    sc.onload = () => res(window.XLSX); sc.onerror = () => rej(new Error("Không tải được thư viện đọc Excel"));
    document.head.appendChild(sc);
  });
}
function cellDate(X, c) {
  if (!c || c.v === undefined || c.v === null || c.v === "") return null;
  if (typeof c.v === "number") { const o = X.SSF.parse_date_code(c.v); if (!o) return null; return `${o.y}-${String(o.m).padStart(2, "0")}-${String(o.d).padStart(2, "0")}`; }
  const m = String(c.v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
async function importExcel() {
  const f = $("impFile").files[0]; if (!f) return;
  setStatus("Đang đọc file Excel…");
  try {
    const X = await loadXLSX(), wb = X.read(await f.arrayBuffer(), { type: "array" });
    let ws = wb.Sheets[P.excelSheet];
    if (!ws) { const nm = wb.SheetNames.find((n) => { const c = wb.Sheets[n]["AA6"]; return c && String(c.v).trim() === "Móng"; }); ws = nm && wb.Sheets[nm]; }
    if (!ws) throw new Error(`Không thấy sheet ${P.excelSheet} (ô AA6 = "Móng")`);
    const known = new Set(P.geo.map((g) => g[0])), rows = {}, cols = ["AD", "AE", "AF", "AG", "AH", "AI"];
    for (let r = P.excelFirstRow; r <= 1000; r++) {
      const c = ws["AA" + r]; if (!c || c.v === "" || c.v === undefined) continue;
      const n = String(c.v).trim(); if (!known.has(n)) continue;
      rows[n] = cols.map((k) => cellDate(X, ws[k + r]));
    }
    const list = Object.keys(rows); if (!list.length) throw new Error("Không đọc được móng nào");
    sel.clear(); multi = false; $("multiBtn").classList.remove("on");
    const res = await saveMany(list, (n) => rows[n], "Nhập từ Excel");
    if (res.fail) setStatus("Nhập Excel bị lỗi", "warn"); else setStatus(`Đã nhập Excel: ${res.done} móng thay đổi`, "ok");
  } catch (e) { setStatus("Nhập Excel lỗi: " + e.message, "warn"); }
}

function excelSerial(s) { const [y, m, d] = s.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; }
async function exportExcel() {
  try {
    const X = await loadXLSX(), asof = $("asof").value;
    const aoa = [["Móng", ...STEPS.map((s) => s.name), "Công tác hiện tại", "Cập nhật lần cuối", "Người cập nhật"]];
    P.geo.map((g) => g[0]).sort((a, b) => a - b).forEach((n) => {
      const r = rec(n), l = level(n, asof);
      aoa.push([Number(n), ...norm(r.d).map((d) => (d && d <= asof ? { t: "n", v: excelSerial(d), z: "dd/mm/yyyy" } : "")),
        l === 0 ? "Chưa thi công" : STEPS[l - 1].name, r.at ? new Date(r.at).toLocaleString("vi-VN") : "", r.byName || ""]);
    });
    const ws = X.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 7 }, ...STEPS.map(() => ({ wch: 12 })), { wch: 16 }, { wch: 20 }, { wch: 22 }];
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "TienDo");
    X.writeFile(wb, `TienDo_${P.id}_${asof}.xlsx`);
  } catch (e) { setStatus("Xuất Excel lỗi: " + e.message, "warn"); }
}

// ---------- Xuất ảnh ----------
async function exportPng() {
  try {
    const asof = $("asof").value, W = 3600, s = W / P.width, mapH = Math.round(P.height * s);
    const head = 170, foot = 150, cv = document.createElement("canvas");
    cv.width = W; cv.height = head + mapH + foot;
    const c = cv.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
    const img = new Image(); img.src = P.image; await img.decode();
    c.drawImage(img, 0, head, W, mapH);
    P.geo.forEach(([n, x, y, w, h]) => {
      const l = level(n, asof);
      c.globalAlpha = l === 0 ? 0.55 : 0.72; c.fillStyle = colorOf(l);
      c.fillRect(x * s, head + y * s, w * s, h * s);
      c.globalAlpha = 0.6; c.strokeStyle = "#334155"; c.lineWidth = 1.5; c.strokeRect(x * s, head + y * s, w * s, h * s);
      c.globalAlpha = 1; c.fillStyle = "#0f172a";
      const vert = h > w * 1.4, fs = Math.max(70, Math.min(170, (vert ? w : h) * 0.95)) * s;
      c.font = `bold ${fs}px Arial`; c.textAlign = "center"; c.textBaseline = "middle";
      c.save(); c.translate((x + w / 2) * s, head + (y + h / 2) * s); if (vert) c.rotate(-Math.PI / 2); c.fillText(n, 0, 0); c.restore();
    });
    c.fillStyle = "#111"; c.textAlign = "center"; c.textBaseline = "alphabetic";
    c.font = "bold 56px Arial"; c.fillText(P.title, W / 2, 70);
    c.font = "34px Arial"; c.textAlign = "left";
    c.fillText(`Công trình: ${P.congTrinh}`, 40, 125); c.fillText(`Địa điểm: ${P.diaDiem}`, 40, 160);
    c.textAlign = "right"; c.fillText(`Ngày: ${fmt(asof)}`, W - 40, 125);
    const cnt = stats(asof), total = P.geo.length, y0 = head + mapH + 30, colW = (W - 80) / 7;
    c.textAlign = "center"; c.font = "bold 32px Arial";
    ["Tổng số móng", ...STEPS.map((x) => x.name)].forEach((t, i) => c.fillText(t, 40 + colW * (i + 0.5), y0 + 30));
    c.font = "32px Arial";
    [String(total), ...cnt.map((k) => `${k} (${Math.round((k / total) * 100)}%)`)].forEach((t, i) => c.fillText(t, 40 + colW * (i + 0.5), y0 + 85));
    STEPS.forEach((st, i) => { c.fillStyle = st.color; c.fillRect(40 + colW * (i + 1) + 20, y0 + 100, colW - 40, 10); });
    const a = document.createElement("a"); a.download = `MatBang_${P.id}_${asof}.png`; a.href = cv.toDataURL("image/png"); a.click();
  } catch (e) { setStatus("Xuất ảnh lỗi: " + e.message, "warn"); }
}

// ---------- Quản lý người dùng ----------
function openUsers() {
  $("usersDlg").hidden = false; $("usersMsg").textContent = "";
  if (!unsubRoles) unsubRoles = be.watchRoles(renderUsers, (e) => { $("usersMsg").textContent = "Lỗi: " + (e.code || e.message); });
}
function closeUsers() { $("usersDlg").hidden = true; }
function renderUsers(list) {
  const owners = OWNER_EMAILS.map((x) => x.toLowerCase());
  list.sort((a, b) => a.email.localeCompare(b.email));
  let h = `<tr><th>Email</th><th>Tên</th><th>Quyền</th><th></th></tr>`;
  owners.forEach((o) => { h += `<tr><td class="em">${esc(o)}</td><td>Chủ hệ thống</td><td>Quản trị</td><td></td></tr>`; });
  list.filter((u) => !owners.includes(u.email)).forEach((u) => {
    h += `<tr><td class="em">${esc(u.email)}</td><td>${esc(u.name || "")}</td><td><select data-em="${esc(u.email)}">` +
      Object.keys(ROLE_LABEL).map((k) => `<option value="${k}"${u.role === k ? " selected" : ""}>${ROLE_LABEL[k]}</option>`).join("") +
      `</select></td><td><button class="x" data-del="${esc(u.email)}" title="Xoá quyền">×</button></td></tr>`;
  });
  $("usersTbl").innerHTML = h;
  $("usersTbl").querySelectorAll("select").forEach((s) => {
    s.onchange = async () => {
      const u = list.find((x) => x.email === s.dataset.em);
      try { await be.setRole(s.dataset.em, { role: s.value, name: (u && u.name) || "", by: me.email, at: new Date().toISOString() }); $("usersMsg").textContent = "Đã đổi quyền."; }
      catch (e) { $("usersMsg").textContent = "Lỗi: " + (e.code || e.message); }
    };
  });
  $("usersTbl").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Xoá?"; b.style.color = "#d92d20"; b.style.fontSize = "12px"; return; }
      try { await be.deleteRole(b.dataset.del); $("usersMsg").textContent = "Đã xoá quyền."; }
      catch (e) { $("usersMsg").textContent = "Lỗi: " + (e.code || e.message); }
    };
  });
}
async function addUser(e) {
  e.preventDefault();
  const email = $("newEmail").value.trim().toLowerCase(), name = $("newName").value.trim(), r = $("newRole").value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("usersMsg").textContent = "Email không hợp lệ."; return; }
  try {
    await be.setRole(email, { role: r, name, by: me.email, at: new Date().toISOString() });
    $("usersMsg").textContent = `Đã thêm ${email} (${ROLE_LABEL[r]}).`; $("addUser").reset();
  } catch (err) { $("usersMsg").textContent = "Lỗi: " + (err.code || err.message); }
}

boot();
