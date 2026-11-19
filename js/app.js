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
const ROLE_LV = { none: 0, viewer: 1, editor: 2, admin: 3 };
const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

// ===================== Trạng thái =====================
let be = null;            // backend (Firebase)
let P = null;             // mặt bằng hiện tại (data/xxx.json)
let PROJECTS = [];        // mặt bằng người dùng được xem
let ALL_PROJECTS = [];    // toàn bộ mặt bằng (data/projects.json)
let roleDoc = null;       // {role: quyền mặc định cho mọi nhà, houses: {mã nhà: quyền riêng}}
let isOwnerUser = false;
const projCache = {};
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
// Đơn vị cấu kiện của mặt bằng: "móng" hoặc "đà kiềng"
const U = (prj) => ((prj || P) && (prj || P).unit) || "móng";
const UC = (prj) => { const u = U(prj); return u.charAt(0).toUpperCase() + u.slice(1); };
// Quyền theo nhà: mã nhà = phần đầu id mặt bằng (nsp, nk, nvp, npt1, …)
const houseKey = (pid) => pid.split("-")[0];
function houseRole(h) {
  if (isOwnerUser) return "admin";
  if (!roleDoc) return "none";
  const o = roleDoc.houses && roleDoc.houses[h];
  return o || roleDoc.role || "none";
}
const isSysAdmin = () => isOwnerUser || (roleDoc && roleDoc.role === "admin");
const canEdit = () => role === "editor" || role === "admin";
const isAdmin = () => role === "admin";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function todayStr() { const t = new Date(); t.setMinutes(t.getMinutes() - t.getTimezoneOffset()); return t.toISOString().slice(0, 10); }
function fmt(s) { if (!s) return ""; const p = s.split("-"); return `${p[2]}/${p[1]}/${p[0]}`; }
function rec(n) { return data[n] || { d: [null, null, null, null, null, null], h: [] }; }
function norm(a) { const o = []; for (let i = 0; i < 6; i++) o.push(a && a[i] ? a[i] : null); return o; }
// Ô lấp đất (id "O1", "O2", …): vùng giữa các đà kiềng, chỉ theo dõi công tác Lấp đất.
// Mặt bằng có ô (prj.cells) thì Lấp đất được tính theo ô, đà kiềng chỉ theo dõi 5 công tác đầu.
const isCell = (n) => /^O\d+$/.test(n);
const ALL_STEPS = [0, 1, 2, 3, 4, 5];
// Công tác theo dõi của mặt bằng (prj.steps), mặc định cả 6
const prjSteps = (prj) => (prj && prj.steps) || ALL_STEPS;
function stepsFor(prj, n) {
  if (!prj) return ALL_STEPS;
  const base = prjSteps(prj);
  if (!prj.cells) return base;
  const cs = prj.cellStep ?? 5;
  return isCell(n) ? [cs] : base.filter((i) => i !== cs);
}
function levelIn(prj, map, n, asof) {
  const d = (map[n] && map[n].d) || [], st = stepsFor(prj, n);
  for (let k = st.length - 1; k >= 0; k--) { const i = st[k]; if (d[i] && (!asof || d[i] <= asof)) return i + 1; }
  return 0;
}
function level(n, asof) { return levelIn(P, data, n, asof); }
// Số hiệu hiển thị của ô (id giữ cố định để dữ liệu không lệch khi bỏ bớt ô)
function cellLabel(n, prj) {
  prj = prj || P;
  if (!prj._cl) { prj._cl = {}; (prj.cells || []).forEach((c) => (prj._cl[c.n] = c.t)); }
  return prj._cl[n] || n.slice(1);
}
function itemName(n, prj) { return isCell(n) ? `O${cellLabel(n, prj)}` : `${UC(prj)} ${n}`; }
const sortKey = (n) => (isCell(n) ? 100000 + Number(cellLabel(n)) : Number(n));
// Đường SVG cho ô có nhiều vòng (vòng ngoài + lỗ móng), tô theo evenodd
function ringsPath(rings) {
  return rings.map((p) => { let d = `M${p[0]},${p[1]}`; for (let i = 2; i < p.length; i += 2) d += `L${p[i]},${p[i + 1]}`; return d + "Z"; }).join("");
}
// Thống kê: cnt[i] = số cấu kiện đã xong công tác i (cộng dồn), tot[i] = tổng số cấu kiện của công tác i
function statsIn(prj, map, asof) {
  const cnt = [0, 0, 0, 0, 0, 0], tot = [0, 0, 0, 0, 0, 0], cs = prj.cells ? (prj.cellStep ?? 5) : -1;
  prj.geo.forEach((g) => {
    const l = levelIn(prj, map, g.n, asof);
    const st = stepsFor(prj, g.n);
    // l là công tác cao nhất đã xong; các công tác theo dõi đứng trước nó coi như đã xong
    st.forEach((i) => { tot[i]++; if (l > i) cnt[i]++; });
  });
  if (prj.cells) prj.cells.forEach((c) => { tot[cs]++; if (levelIn(prj, map, c.n, asof)) cnt[cs]++; });
  return { cnt, tot };
}
const colorOf = (l) => (l === 0 ? NONE_COLOR : STEPS[l - 1].color);
function setStatus(t, c) { const s = $("status"); s.textContent = t; s.className = "status " + (c || ""); }

// ===================== Khởi động =====================
const GOOGLE_SVG = '<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function gate(html) { $("gate").hidden = false; $("app").hidden = true; $("gateBody").innerHTML = html; }

function showLogin(err, info, mode) {
  mode = mode || "login";
  const lastEmail = (() => { try { return localStorage.getItem("cftn_email") || ""; } catch (e) { return ""; } })();
  const titles = { login: "Đăng nhập bằng email", signup: "Tạo mật khẩu lần đầu", reset: "Quên mật khẩu" };
  const btn = { login: "Đăng nhập", signup: "Tạo tài khoản", reset: "Gửi email đặt lại mật khẩu" };
  gate(`<button class="gbtn" id="gLogin">${GOOGLE_SVG}Đăng nhập bằng Google</button>
    <div class="or"><span>hoặc dùng email khác (Outlook, Microsoft 365, …)</span></div>
    <form id="emForm" class="emform">
      <b>${titles[mode]}</b>
      <input type="email" id="emEmail" placeholder="Email" autocomplete="email" required value="${esc(lastEmail)}">
      ${mode !== "reset" ? `<input type="password" id="emPass" placeholder="${mode === "signup" ? "Đặt mật khẩu (ít nhất 6 ký tự)" : "Mật khẩu"}" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required minlength="6">` : ""}
      ${mode === "signup" ? `<input type="password" id="emPass2" placeholder="Nhập lại mật khẩu" autocomplete="new-password" required minlength="6">` : ""}
      <button class="primary" type="submit" id="emBtn">${btn[mode]}</button>
      <div class="links">
        ${mode !== "login" ? `<a href="#" data-mode="login">Đã có mật khẩu? Đăng nhập</a>` : `<a href="#" data-mode="signup">Lần đầu vào? Tạo mật khẩu</a>`}
        ${mode !== "reset" ? `<a href="#" data-mode="reset">Quên mật khẩu</a>` : ""}
      </div>
    </form>` +
    (err ? `<div class="err">${esc(err)}</div>` : "") + (info ? `<div class="ok">${info}</div>` : "") +
    `<p class="muted small" style="margin-top:16px">Chỉ email đã được quản trị viên cấp quyền mới xem được dữ liệu.</p>`);
  $("gLogin").onclick = async () => {
    try { await be.signIn(); } catch (e) { const m = loginErr(e); if (m) showLogin(m, null, mode); }
  };
  document.querySelectorAll("#gateBody [data-mode]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); showLogin(null, null, a.dataset.mode); };
  });
  $("emForm").onsubmit = async (e) => {
    e.preventDefault();
    const email = $("emEmail").value.trim().toLowerCase();
    try { localStorage.setItem("cftn_email", email); } catch (x) {}
    $("emBtn").disabled = true;
    try {
      if (mode === "login") await be.signInEmail(email, $("emPass").value);
      else if (mode === "signup") {
        if ($("emPass").value !== $("emPass2").value) { showLogin("Hai lần nhập mật khẩu không khớp.", null, "signup"); return; }
        await be.signUpEmail(email, $("emPass").value);
      } else {
        await be.resetPassword(email);
        showLogin(null, `Nếu <b>${esc(email)}</b> đã có tài khoản, thư đặt lại mật khẩu đã được gửi. Kiểm tra cả mục Spam / Junk.`, "login");
      }
    } catch (x) { showLogin(loginErr(x), null, mode); }
  };
}
function loginErr(e) {
  const c = e && e.code || "";
  const M = {
    "auth/unauthorized-domain": "Tên miền này chưa được thêm vào Firebase (Authentication → Settings → Authorized domains).",
    "auth/popup-closed-by-user": "", "auth/cancelled-popup-request": "",
    "auth/operation-not-allowed": "Phương thức đăng nhập này chưa được bật trong Firebase Authentication.",
    "auth/invalid-credential": "Sai email hoặc mật khẩu. Nếu lần đầu vào, chọn \"Tạo mật khẩu\".",
    "auth/wrong-password": "Sai mật khẩu.", "auth/user-not-found": "Email chưa có tài khoản. Chọn \"Tạo mật khẩu\".",
    "auth/email-already-in-use": "Email này đã có tài khoản. Hãy đăng nhập, hoặc dùng \"Quên mật khẩu\".",
    "auth/weak-password": "Mật khẩu quá yếu – cần ít nhất 6 ký tự.",
    "auth/invalid-email": "Email không hợp lệ.",
    "auth/too-many-requests": "Thử quá nhiều lần. Đợi vài phút rồi thử lại.",
    "auth/network-request-failed": "Lỗi mạng. Kiểm tra kết nối Internet.",
  };
  if (c in M) return M[c];
  return "Đăng nhập lỗi: " + (e && e.message || e);
}

function showVerify(u, note) {
  gate(`<p>Đã gửi thư xác nhận tới <b>${esc(u.email)}</b>.</p>
    <p class="muted small">Mở hộp thư (kiểm tra cả Spam / Junk), bấm vào link xác nhận, rồi quay lại đây bấm nút bên dưới.</p>
    <button class="primary" id="vDone" style="margin-top:8px">Tôi đã xác nhận email</button>
    <div class="links" style="justify-content:center;margin-top:12px"><a href="#" id="vResend">Gửi lại thư</a><a href="#" id="vOut">Dùng tài khoản khác</a></div>
    ${note ? `<div class="${note.ok ? "ok" : "err"}">${note.text}</div>` : ""}`);
  $("vDone").onclick = async () => {
    try { const nu = await be.reloadUser(); if (nu.emailVerified) afterLogin(nu); else showVerify(u, { text: "Email chưa được xác nhận. Hãy bấm link trong thư trước." }); }
    catch (e) { showVerify(u, { text: loginErr(e) }); }
  };
  $("vResend").onclick = async (e) => {
    e.preventDefault();
    try { await be.resendVerification(); showVerify(u, { ok: true, text: "Đã gửi lại thư xác nhận." }); }
    catch (x) { showVerify(u, { text: loginErr(x) }); }
  };
  $("vOut").onclick = (e) => { e.preventDefault(); be.signOut(); };
}

async function boot() {
  try {
    ALL_PROJECTS = await (await fetch("data/projects.json", { cache: "no-cache" })).json();
  } catch (e) { gate(`<div class="err">Không tải được danh sách mặt bằng.</div>`); return; }
  try {
    be = await import("./backend.js");
  } catch (e) { gate(`<div class="err">Không tải được Firebase. Kiểm tra kết nối mạng.<br><small>${esc(e.message)}</small></div>`); return; }

  be.onUser((u) => {
    cleanup();
    if (!u) { me = null; role = null; showLogin(); return; }
    if (!u.emailVerified) { me = null; role = null; showVerify(u); return; }
    afterLogin(u);
  });
}

async function afterLogin(u) {
    me = { uid: u.uid, email: (u.email || "").toLowerCase(), name: u.displayName || u.email };
    gate(`<p class="muted">Đang kiểm tra quyền của <b>${esc(me.email)}</b>…</p>`);
    role = null; roleDoc = null;
    isOwnerUser = OWNER_EMAILS.map((x) => x.toLowerCase()).includes(me.email);
    if (!isOwnerUser) { try { roleDoc = await be.getRole(me.email); } catch (e) { roleDoc = null; } }
    PROJECTS = ALL_PROJECTS.filter((x) => ROLE_LV[houseRole(houseKey(x.id))] >= 1);
    if (!PROJECTS.length) {
      gate(`<p>Tài khoản <b>${esc(me.email)}</b> chưa được cấp quyền.</p>
            <p class="muted small">Gửi email này cho quản trị viên để được thêm vào danh sách, rồi tải lại trang.</p>
            <button id="gOut" style="margin-top:10px">Đăng nhập tài khoản khác</button>`);
      $("gOut").onclick = () => be.signOut();
      return;
    }
    startApp();
}

function cleanup() {
  if (unsubMong) { unsubMong(); unsubMong = null; }
  if (unsubRoles) { unsubRoles(); unsubRoles = null; }
  data = {}; sel.clear(); online = false; lastMsg = null;
}

// ===================== Ứng dụng =====================
let built = false;
// Tên mặt bằng dạng "Nhà … – Móng" → [nhà, loại mặt bằng]
function splitName(n) { const i = n.lastIndexOf(" – "); return i < 0 ? [n, ""] : [n.slice(0, i), n.slice(i + 3)]; }
const KIND_ORDER = ["Móng", "Đà kiềng", "Cổ cột", "Cột tầng 1"];
function plansOf(h) {
  return PROJECTS.filter((x) => splitName(x.name)[0] === h)
    .sort((a, b) => KIND_ORDER.indexOf(splitName(a.name)[1]) - KIND_ORDER.indexOf(splitName(b.name)[1]));
}
function houses() { const out = []; PROJECTS.forEach((x) => { const h = splitName(x.name)[0]; if (!out.includes(h)) out.push(h); }); return out; }
function syncSelectors(id) {
  const meta = PROJECTS.find((x) => x.id === id), h = splitName(meta.name)[0];
  $("houseSel").value = h;
  $("kindSel").innerHTML = plansOf(h).map((x) => `<option value="${esc(x.id)}">${esc(splitName(x.name)[1])}</option>`).join("");
  $("kindSel").value = id;
}
async function loadProject(id) {
  const meta = PROJECTS.find((x) => x.id === id) || PROJECTS[0];
  if (!projCache[meta.id]) projCache[meta.id] = await (await fetch(meta.file, { cache: "no-cache" })).json();
  return projCache[meta.id];
}
function currentHashId() { const h = location.hash.replace("#", ""); return PROJECTS.some((x) => x.id === h) ? h : PROJECTS[0].id; }

async function switchProject(id) {
  if (unsubMong) { unsubMong(); unsubMong = null; }
  data = {}; sel.clear(); online = false; lastMsg = null;
  multi = false; $("multiBtn").classList.remove("on"); setSheet(false);
  try { P = await loadProject(id); } catch (e) { setStatus("Không tải được mặt bằng", "warn"); return; }
  if (location.hash.replace("#", "") !== P.id) history.replaceState(null, "", "#" + P.id);
  syncSelectors(P.id);
  applyRole();
  $("multiBtn").textContent = P.cells ? "Chọn nhiều" : `Chọn nhiều ${U()}`;
  $("pTitle").textContent = P.title; $("pCT").textContent = P.congTrinh; $("pDD").textContent = P.diaDiem;
  document.title = P.name + " – " + P.title;
  buildMap(); requestAnimationFrame(() => fit(isMobile()));
  paint(); renderPanel();
  setStatus("Đang tải dữ liệu…");
  const timer = setTimeout(() => setStatus("Chưa kết nối được dữ liệu – đang thử lại…", "warn"), 10000);
  const pid = P.id;
  unsubMong = be.watchMong(pid, (d, fromCache) => {
    if (!P || P.id !== pid) return;
    data = d;
    if (!fromCache && !online) { clearTimeout(timer); online = true; setStatus("Trực tuyến", "ok"); }
    if (!saving) { paint(); renderPanel(); }
  }, (err) => { clearTimeout(timer); setStatus("Lỗi dữ liệu: " + (err.code || err.message), "warn"); });
}

// Quyền của người dùng trên nhà của mặt bằng đang xem
function applyRole() {
  role = houseRole(houseKey(P.id));
  const b = $("roleBadge"); b.textContent = ROLE_LABEL[role] || ""; b.className = "badge " + role;
  document.querySelectorAll(".adm").forEach((e) => (e.hidden = !PROJECTS.some((x) => houseRole(houseKey(x.id)) === "admin")));
  document.querySelectorAll(".ed").forEach((e) => (e.hidden = !canEdit()));
}

function startApp() {
  $("gate").hidden = true; $("app").hidden = false;
  $("userName").textContent = me.name;
  $("usersBtn").hidden = !isSysAdmin();
  $("houseSel").innerHTML = houses().map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join("");
  if (!built) {
    $("houseSel").innerHTML = houses().map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join("");
    bindUI(); built = true;
  }
  switchProject(currentHashId());
}

// ---------- Vẽ mặt bằng ----------
const NS = "http://www.w3.org/2000/svg";
const nodes = {};
const vb = { x: 0, y: 0, w: 1, h: 1 };
function setVB() { $("map").setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }

function buildMap() {
  const svg = $("map");
  svg.innerHTML = "";
  for (const k in nodes) delete nodes[k];
  const img = document.createElementNS(NS, "image");
  img.setAttribute("href", P.image);
  img.setAttribute("x", 0); img.setAttribute("y", 0);
  img.setAttribute("width", P.width); img.setAttribute("height", P.height);
  img.setAttribute("preserveAspectRatio", "none");
  svg.appendChild(img);
  (P.cells || []).forEach(({ n, t: label, r: rings, l, f }) => {
    const g = document.createElementNS(NS, "g"); g.setAttribute("class", "mong cell"); g.dataset.n = n;
    const r = document.createElementNS(NS, "path");
    r.setAttribute("d", ringsPath(rings)); r.setAttribute("fill-rule", "evenodd");
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", l[0]); t.setAttribute("y", l[1]); t.setAttribute("font-size", f);
    t.textContent = "O" + label;
    const tt = document.createElementNS(NS, "title");
    g.append(tt, r, t); svg.appendChild(g);
    nodes[n] = { g, r, tt, cell: true };
  });
  P.geo.forEach(({ n, p, l, a, f }) => {
    const g = document.createElementNS(NS, "g"); g.setAttribute("class", "mong"); g.dataset.n = n;
    const r = document.createElementNS(NS, "polygon");
    const pts = []; for (let i = 0; i < p.length; i += 2) pts.push(p[i] + "," + p[i + 1]);
    r.setAttribute("points", pts.join(" "));
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", l[0]); t.setAttribute("y", l[1]); t.setAttribute("font-size", f);
    if (a) t.setAttribute("transform", `rotate(${a} ${l[0]} ${l[1]})`);
    t.textContent = n;
    const tt = document.createElementNS(NS, "title");
    g.append(tt, r, t); svg.appendChild(g);
    nodes[n] = { g, r, tt };
  });
  vb.w = P.width; vb.h = P.height; setVB();
  const lg = [`<span><i class="sw" style="background:#fff"></i>Chưa thi công</span>`]
    .concat(prjSteps(P).map((i) => STEPS[i]).map((s) => `<span><i class="sw" style="background:${s.color};opacity:.8"></i>${s.name}</span>`));
  $("legend").innerHTML = lg.join("");
}

function paint() {
  const asof = $("asof").value;
  for (const n in nodes) {
    const l = level(n, asof), o = nodes[n];
    o.r.setAttribute("fill", colorOf(l));
    if (o.cell) o.r.setAttribute("fill-opacity", l === 0 ? "0.04" : "0.45");
    else o.r.setAttribute("fill-opacity", l === 0 ? "0.55" : "0.72");
    o.g.classList.toggle("sel", sel.has(n));
    o.g.classList.toggle("done", l > 0);
    o.tt.textContent = `${itemName(n)} – ${l === 0 ? (o.cell ? "Chưa lấp đất" : "Chưa thi công") : STEPS[l - 1].name}`;
  }
  renderStats();
}

function stats(asof) { return statsIn(P, data, asof).cnt; }
function renderStats() {
  const asof = $("asof").value, { cnt, tot } = statsIn(P, data, asof), cs = P.cells ? (P.cellStep ?? 5) : -1;
  $("statDate").textContent = fmt(asof);
  let h = `<tr><td>Tổng số ${U()}</td><td>${P.geo.length}</td></tr>`;
  if (P.cells) h += `<tr><td>Tổng số ô lấp đất</td><td>${P.cells.length}</td></tr>`;
  STEPS.forEach((s, i) => {
    if (!prjSteps(P).includes(i)) return;
    const p = tot[i] ? Math.round((cnt[i] / tot[i]) * 100) : 0;
    const v = i === cs ? `${cnt[i]}/${tot[i]} ô (${p}%)` : `${cnt[i]} (${p}%)`;
    h += `<tr><td>${s.name}${i === cs ? " <small class=\"muted\">(theo ô)</small>" : ""}<div class="bar"><i style="width:${p}%;background:${s.color}"></i></div></td><td>${v}</td></tr>`;
  });
  $("stats").innerHTML = h;
  updateHandle();
}

// ---------- Phóng to / di chuyển ----------
function fit(cover) {
  const r = $("map").getBoundingClientRect(); if (!r.width || !r.height) return;
  const ar = r.width / r.height, iar = P.width / P.height;
  if (cover === true && ar < iar) { vb.h = P.height; vb.w = P.height * ar; vb.x = (P.width - vb.w) / 2; vb.y = 0; setVB(); return; }
  if (ar > iar) { vb.h = P.height; vb.w = P.height * ar; vb.x = -(vb.w - P.width) / 2; vb.y = 0; }
  else { vb.w = P.width; vb.h = P.width / ar; vb.y = -(vb.h - P.height) / 2; vb.x = 0; }
  setVB();
}
function zoomAt(f, cx, cy) {
  const svg = $("map"), r = svg.getBoundingClientRect();
  let nw = vb.w / f;
  const minW = P.width / 20, maxW = P.width * 3;
  if (nw < minW) { f = vb.w / minW; nw = minW; } else if (nw > maxW) { f = vb.w / maxW; nw = maxW; }
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
  $("zfit").onclick = () => fit(false);

  // Kéo 1 ngón = di chuyển; 2 ngón = phóng to quanh tâm 2 ngón + di chuyển theo tâm.
  // Mỗi khi số ngón thay đổi, gesture được đặt lại từ vị trí hiện tại → không bị nhảy khi nhấc 1 ngón.
  const ptrs = new Map(); let moved = false, gest = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function resetGesture() {
    const a = [...ptrs.values()];
    if (a.length === 1) gest = { type: "pan", x: a[0].x, y: a[0].y, vx: vb.x, vy: vb.y };
    else if (a.length >= 2) gest = { type: "pinch", d: dist(a[0], a[1]), mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2 };
    else gest = null;
  }
  svg.addEventListener("pointerdown", (e) => {
    try { svg.setPointerCapture(e.pointerId); } catch (x) {}
    if (ptrs.size === 0) moved = false;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) moved = true;
    resetGesture();
  });
  svg.addEventListener("pointermove", (e) => {
    if (!ptrs.has(e.pointerId) || !gest) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = svg.getBoundingClientRect(), a = [...ptrs.values()];
    if (gest.type === "pinch" && a.length >= 2) {
      const d = dist(a[0], a[1]), mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
      // di chuyển theo tâm 2 ngón
      vb.x -= ((mx - gest.mx) / r.width) * vb.w; vb.y -= ((my - gest.my) / r.height) * vb.h;
      // phóng to quanh tâm 2 ngón
      if (d > 0 && gest.d > 0) zoomAt(d / gest.d, mx, my); else setVB();
      gest.d = d; gest.mx = mx; gest.my = my;
      return;
    }
    if (gest.type === "pan") {
      const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
      if (!moved && Math.hypot(dx, dy) > 6) { moved = true; svg.classList.add("dragging"); }
      if (moved) { vb.x = gest.vx - (dx / r.width) * vb.w; vb.y = gest.vy - (dy / r.height) * vb.h; setVB(); }
    }
  });
  const endPtr = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const tap = ptrs.size === 1 && !moved && e.type === "pointerup";
    ptrs.delete(e.pointerId);
    if (tap) {
      const el = document.elementFromPoint(e.clientX, e.clientY), g = el && el.closest && el.closest(".mong");
      if (g) clickMong(g.dataset.n); else if (!multi) { sel.clear(); paint(); renderPanel(); setSheet(false); }
    }
    resetGesture();
    if (ptrs.size === 0) svg.classList.remove("dragging");
  };
  svg.addEventListener("pointerup", endPtr); svg.addEventListener("pointercancel", endPtr);
  // Chặn trình duyệt iOS tự phóng to cả trang khi chụm ngón trên mặt bằng
  ["gesturestart", "gesturechange", "gestureend"].forEach((t) => svg.addEventListener(t, (e) => e.preventDefault()));
  // Chạm 2 lần để phóng to
  let lastTap = 0;
  svg.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch" || moved) return;
    const now = Date.now();
    if (now - lastTap < 300) { zoomAt(2, e.clientX, e.clientY); lastTap = 0; } else lastTap = now;
  });

  $("multiBtn").onclick = () => {
    multi = !multi; $("multiBtn").classList.toggle("on", multi);
    if (multi && isMobile()) setSheet(false);
    if (!multi && sel.size > 1) { const f = [...sel][0]; sel.clear(); sel.add(f); }
    paint(); renderPanel();
  };
  $("clearSel").onclick = () => { sel.clear(); paint(); renderPanel(); };
  $("asof").onchange = paint;
  $("houseSel").onchange = () => {
    const h = $("houseSel").value, cur = splitName(P ? PROJECTS.find((x) => x.id === P.id).name : "")[1];
    const list = plansOf(h);
    const pick = list.find((x) => splitName(x.name)[1] === cur) || list[0];
    switchProject(pick.id);
  };
  $("kindSel").onchange = () => switchProject($("kindSel").value);
  window.addEventListener("hashchange", () => { const id = currentHashId(); if (me && role && (!P || P.id !== id)) switchProject(id); });
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
  $("pdfBtn").onclick = openPdfMenu;
  document.querySelector(".toolbar").addEventListener("scroll", closePdfMenu, { passive: true });
  $("handle").onclick = () => setSheet(!$("aside").classList.contains("open"));
  $("pdfOne").onclick = () => exportPdf(false);
  $("pdfAll").onclick = () => exportPdf(true);
  document.addEventListener("click", (e) => { if (!e.target.closest || !e.target.closest(".pdfwrap")) closePdfMenu(); });
}

const isMobile = () => window.matchMedia("(max-width:820px)").matches;
function setSheet(open) { $("aside").classList.toggle("open", !!open); updateHandle(); }
function updateHandle() {
  const t = $("handleText"); if (!t || !P) return;
  if (sel.size === 1 && !multi) {
    const n = [...sel][0], l = level(n, $("asof").value);
    t.textContent = `${itemName(n)} – ${l === 0 ? (isCell(n) ? "Chưa lấp đất" : "Chưa thi công") : STEPS[l - 1].name}`;
  } else if (sel.size > 0) t.textContent = `${sel.size} cấu kiện đã chọn` + (isMobile() && !$("aside").classList.contains("open") ? " – bấm ▲ để cập nhật" : "");
  else if (multi && isMobile()) t.textContent = "Chọn nhiều: chạm các cấu kiện cần cập nhật";
  else {
    const { cnt, tot } = statsIn(P, data, $("asof").value), pc = (i) => (tot[i] ? Math.round(cnt[i] / tot[i] * 100) : 0);
    const vs = prjSteps(P).slice(-2);
    t.textContent = `Tổng hợp: ${P.geo.length} ${U()} · ` + vs.map((i) => `${STEPS[i].name} ${pc(i)}%`).join(" · ");
  }
}

function clickMong(n) {
  if (multi) { sel.has(n) ? sel.delete(n) : sel.add(n); } else { sel.clear(); sel.add(n); }
  paint(); renderPanel();
  // Chọn nhiều trên điện thoại: giữ ngăn kéo thu gọn để dễ chọn; bấm ▲ khi chọn xong
  if (isMobile() && !multi) { setSheet(true); $("aside").scrollTop = 0; }
}

// ---------- Bảng bên phải ----------
function renderPanel() {
  _renderPanel(); updateHandle();
  if (lastMsg && Date.now() - lastMsg.t < 5000) { const m = $("msg"); if (m) { m.textContent = lastMsg.text; m.style.color = lastMsg.ok ? "#05603a" : "#b42318"; } }
}
function msg(text, ok) { lastMsg = { text, ok, t: Date.now() }; const m = $("msg"); if (m) { m.textContent = text; m.style.color = ok ? "#05603a" : "#b42318"; } }

function _renderPanel() {
  const panel = $("panel");
  const ro = !canEdit() ? `<div class="note">Bạn có quyền chỉ xem.</div>` : "";
  if (sel.size === 0) {
    const emptyDb = online && Object.keys(data).length === 0;
    panel.innerHTML = `<h2>Chi tiết ${U()}</h2>${ro}` +
      (emptyDb && isAdmin() ? `<div class="note info">Mặt bằng này chưa có dữ liệu. Bấm <b>⬆ Nhập từ Excel</b> và chọn file có sheet <b>${esc(P.excelSheet)}</b>.</div>` : "") +
      `<div class="empty">Bấm vào một ${U()} trên mặt bằng để xem${canEdit() ? " và nhập ngày hoàn thành từng công tác" : " ngày hoàn thành từng công tác"}.` +
      (canEdit() ? `<br><br>Muốn cập nhật cả loạt, bật <b>Chọn nhiều</b> rồi bấm lần lượt các ${U()}.` : "") +
      `</div><div class="msg" id="msg"></div>`;
    return;
  }
  if (sel.size === 1 && !multi) return renderSingle([...sel][0], ro);
  renderMulti(ro);
}

function renderSingle(n, ro) {
  const panel = $("panel"), r = rec(n), l = level(n, null), ed = canEdit(), allowed = stepsFor(P, n), cell = isCell(n);
  let h = `<div class="selhead"><b>${esc(itemName(n))}</b><small>${l === 0 ? (cell ? "Chưa lấp đất" : "Chưa thi công") : "Đã xong: " + STEPS[l - 1].name}</small></div>${ro}`;
  if (cell) h += `<div class="note info">Ô lấp đất giữa các ${U()} – chỉ theo dõi công tác Lấp đất.</div>`;
  else if (P.cells) h += `<div class="muted small" style="margin-bottom:8px">Lấp đất được theo dõi theo từng ô giữa các ${U()}.</div>`;
  h += `<div class="steps">`;
  STEPS.forEach((s, i) => {
    if (!allowed.includes(i)) return;
    const v = (r.d && r.d[i]) || "";
    h += `<div class="step"><i class="sw" style="background:${s.color};opacity:.8"></i><span>${s.name}</span>` +
      `<input type="date" data-i="${i}" value="${v}"${ed ? "" : " disabled"}>` +
      (ed ? `<button class="x" data-i="${i}" title="Xoá ngày">×</button>` : "<span></span>") + `</div>`;
  });
  h += `</div>`;
  if (ed) h += `<div class="actions"><button class="primary" id="save" disabled>Lưu</button><button id="quick">${cell ? "✓ Đã lấp đất hôm nay" : "✓ Xong công tác tiếp theo hôm nay"}</button></div>`;
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
  // × xoá ngày của công tác đó (tìm ô nhập theo data-i, vì ô lấp đất chỉ có 1 ô nhập) rồi lưu luôn
  panel.querySelectorAll(".x").forEach((b) => {
    b.onclick = () => {
      const inp = panel.querySelector(`input[type=date][data-i="${b.dataset.i}"]`);
      if (!inp || !inp.value) return;
      inp.value = ""; dirty();
      const nd = norm(r.d); inputs.forEach((x) => (nd[+x.dataset.i] = x.value || null));
      saveMany([n], () => nd);
    };
  });
  saveBtn.onclick = () => { const nd = norm(r.d); inputs.forEach((inp) => (nd[+inp.dataset.i] = inp.value || null)); saveMany([n], () => nd); };
  $("quick").onclick = () => {
    const cur = norm(r.d), nx = allowed.find((i) => i >= level(n, null));
    if (nx === undefined) { msg(`${itemName(n)} đã hoàn thành tất cả công tác.`); return; }
    cur[nx] = todayStr(); saveMany([n], () => cur);
  };
}

function renderMulti(ro) {
  const panel = $("panel"), list = [...sel].sort((a, b) => sortKey(a) - sortKey(b));
  const allowed = ALL_STEPS.filter((i) => list.every((n) => stepsFor(P, n).includes(i)));
  let h = `<div class="selhead"><b>${list.length} cấu kiện đã chọn</b><small>bấm để thêm / bỏ</small></div>${ro}`;
  h += `<div class="multi"><div class="chips">${list.map((n) => `<span>${esc(isCell(n) ? "O" + cellLabel(n) : n)}</span>`).join("")}</div>`;
  if (canEdit() && !allowed.length) {
    h += `<div class="note">Đang chọn lẫn ô lấp đất và ${U()}. Hãy chọn riêng từng loại để cập nhật.</div>`;
  } else if (canEdit()) {
    // Mặc định: công tác hiện tại chung của các cấu kiện đã chọn; nếu khác nhau thì công tác tiếp theo của cấu kiện chậm nhất
    const lv = list.map((n) => level(n, null));
    const same = lv.every((x) => x === lv[0]);
    let defStep = same && lv[0] > 0 ? lv[0] - 1 : Math.min(...lv);
    if (!allowed.includes(defStep)) defStep = allowed.find((i) => i >= defStep) ?? allowed[allowed.length - 1];
    const dates = list.map((n) => norm(rec(n).d)[defStep]);
    const defDate = dates[0] && dates.every((x) => x === dates[0]) ? dates[0] : todayStr();
    h += `<div class="muted small">${same ? (lv[0] ? "Cùng đang ở công tác: <b>" + STEPS[lv[0] - 1].name + "</b>" : (isCell(list[0]) ? "Cùng chưa lấp đất" : "Cùng chưa thi công")) : "Các cấu kiện đang ở công tác khác nhau"}</div>`;
    h += `<label>Công tác <select id="mStep">${allowed.map((i) => `<option value="${i}"${i === defStep ? " selected" : ""}>${STEPS[i].name}</option>`).join("")}</select></label>`;
    h += `<label>Ngày hoàn thành <input type="date" id="mDate" value="${defDate}"></label>`;
    h += `<div class="actions"><button class="primary" id="mSave">Cập nhật ${list.length} cấu kiện</button><button id="mClear">Xoá ngày công tác này</button></div>`;
  }
  h += `<div class="msg" id="msg"></div></div>`;
  panel.innerHTML = h;
  if (!canEdit() || !allowed.length) return;
  $("mStep").onchange = () => {
    const i = +$("mStep").value, ds = list.map((n) => norm(rec(n).d)[i]);
    $("mDate").value = ds[0] && ds.every((x) => x === ds[0]) ? ds[0] : todayStr();
  };
  $("mSave").onclick = () => {
    const i = +$("mStep").value, d = $("mDate").value; if (!d) { msg("Chọn ngày trước."); return; }
    saveMany(list, (n) => { const c = norm(rec(n).d); c[i] = d; return c; });
  };
  $("mClear").onclick = () => {
    const i = +$("mStep").value;
    saveMany(list, (n) => { const c = norm(rec(n).d); c[i] = null; return c; });
  };
}

// ---------- Lưu ----------
function makeEntries(existing, list, makeNew, via) {
  const now = new Date().toISOString(), entries = [];
  list.forEach((n) => {
    const old = existing[n] || { d: [], h: [] }, od = norm(old.d), nd = norm(makeNew(n));
    if (JSON.stringify(od) === JSON.stringify(nd)) return;
    const h = (old.h || []).slice();
    for (let i = 0; i < 6; i++) if (od[i] !== nd[i]) h.push({ s: STEPS[i].name, d: nd[i], by: me.uid, byName: me.name, at: now, via: via || null });
    entries.push([n, { d: nd, by: me.uid, byName: me.name, at: now, h: h.slice(-30) }]);
  });
  return entries;
}
async function saveMany(list, makeNew, via) {
  if (saving || !canEdit()) return { done: 0 };
  saving = true;
  document.querySelectorAll("#panel button").forEach((b) => (b.disabled = true));
  msg("Đang lưu…", true);
  const entries = makeEntries(data, list, makeNew, via);
  let fail = null;
  try {
    if (entries.length === 1) await be.saveMong(P.id, entries[0][0], entries[0][1]);
    else if (entries.length > 1) await be.saveMongMany(P.id, entries);
    entries.forEach(([n, d]) => (data[n] = d));
  } catch (e) { fail = e; }
  saving = false;
  // Lưu xong thì bỏ chọn, tránh cấu kiện vừa tô bị cập nhật theo ở lần chọn sau
  if (!fail && entries.length && !via) { sel.clear(); if (isMobile()) setSheet(false); }
  paint(); renderPanel();
  if (fail) msg("Không lưu được: " + (fail.code === "permission-denied" ? "không có quyền ghi." : fail.code || fail.message));
  else msg(entries.length ? `Đã lưu ${entries.length} cấu kiện.` : "Không có gì thay đổi.", true);
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
    const sheetOf = (x) => [x.excelSheet, ...(x.excelAlt || [])].find((nm) => wb.Sheets[nm]);
    const targets = PROJECTS.filter((x) => sheetOf(x) && houseRole(houseKey(x.id)) === "admin");
    if (!targets.length) throw new Error("File không có sheet nào thuộc nhà bạn được quyền Quản trị");
    const cols = ["AD", "AE", "AF", "AG", "AH", "AI"], report = [];
    saving = true;
    for (const meta of targets) {
      setStatus(`Đang nhập ${meta.name}…`);
      const prj = await loadProject(meta.id), ws = wb.Sheets[sheetOf(meta)];
      const known = new Set(prj.geo.map((g) => g.n)), rows = {};
      for (let r = prj.excelFirstRow || 7; r <= 2000; r++) {
        const c = ws["AA" + r]; if (!c || c.v === "" || c.v === undefined) continue;
        const n = String(c.v).trim(); if (!known.has(n)) continue;
        rows[n] = cols.map((k) => cellDate(X, ws[k + r]));
      }
      const existing = P && prj.id === P.id ? data : await be.getMongAll(prj.id);
      const entries = makeEntries(existing, Object.keys(rows), (n) => rows[n], "Nhập từ Excel");
      if (entries.length) await be.saveMongMany(prj.id, entries);
      if (P && prj.id === P.id) entries.forEach(([n, d]) => (data[n] = d));
      report.push(`${meta.name}: ${entries.length} ${U(prj)} thay đổi`);
    }
    saving = false; sel.clear(); paint(); renderPanel();
    setStatus("Đã nhập Excel – " + report.join(" · "), "ok");
  } catch (e) {
    saving = false;
    setStatus("Nhập Excel lỗi: " + (e.code === "permission-denied" ? "không có quyền ghi" : e.message), "warn");
  }
}

function excelSerial(s) { const [y, m, d] = s.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; }
async function exportExcel() {
  try {
    const X = await loadXLSX(), asof = $("asof").value;
    const VS = prjSteps(P);
    const aoa = [[UC(), ...VS.map((i) => STEPS[i].name), "Công tác hiện tại", "Cập nhật lần cuối", "Người cập nhật"]];
    P.geo.map((g) => g.n).concat((P.cells || []).map((c) => c.n)).sort((a, b) => sortKey(a) - sortKey(b)).forEach((n) => {
      const r = rec(n), l = level(n, asof), allowed = stepsFor(P, n);
      aoa.push([isCell(n) ? "O" + cellLabel(n) : Number(n), ...VS.map((i) => norm(r.d)[i]).map((d, k) => (d && d <= asof && allowed.includes(VS[k]) ? { t: "n", v: excelSerial(d), z: "dd/mm/yyyy" } : "")),
        l === 0 ? (isCell(n) ? "Chưa lấp đất" : "Chưa thi công") : STEPS[l - 1].name, r.at ? new Date(r.at).toLocaleString("vi-VN") : "", r.byName || ""]);
    });
    const ws = X.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 7 }, ...VS.map(() => ({ wch: 12 })), { wch: 16 }, { wch: 20 }, { wch: 22 }];
    const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, P.excelSheet.slice(0, 31));
    X.writeFile(wb, `TienDo_${P.excelSheet}_${asof}.xlsx`);
  } catch (e) { setStatus("Xuất Excel lỗi: " + e.message, "warn"); }
}

// ---------- Xuất ảnh / PDF ----------
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
function loadScript(url, globalName) {
  return new Promise((res, rej) => {
    if (window[globalName]) return res(window[globalName]);
    const sc = document.createElement("script"); sc.src = url;
    sc.onload = () => res(window[globalName]); sc.onerror = () => rej(new Error("Không tải được thư viện " + globalName));
    document.head.appendChild(sc);
  });
}

// Vẽ mặt bằng đã tô màu + tiêu đề + bảng tổng hợp lên canvas
async function renderPlanCanvas(prj, map, asof) {
  // Mặt bằng dẹt (nhà sấy phun): bảng tổng hợp ở dưới.
  // Mặt bằng gần vuông (nhà kho): chú thích + tổng hợp ở bên phải để vừa A3 ngang.
  const A3 = 420 / 297, head = 190, iar = prj.width / prj.height;
  const side = iar < 1.6;
  let W, mapW, mapH, panelX, foot;
  if (side) {
    mapH = 2500; mapW = Math.round(mapH * iar); foot = 50;
    W = Math.max(mapW + 1000, Math.round((head + mapH + foot) * A3));
    panelX = mapW + 60;
  } else {
    W = 3600; mapW = W; mapH = Math.round(W / iar); foot = 200; panelX = 0;
  }
  const s = mapW / prj.width, cv = document.createElement("canvas");
  cv.width = W; cv.height = head + mapH + foot;
  const c = cv.getContext("2d");
  c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
  const img = new Image(); img.src = prj.image; await img.decode();
  c.drawImage(img, 0, head, mapW, mapH);
  const { cnt, tot } = statsIn(prj, map, asof), cs = prj.cells ? (prj.cellStep ?? 5) : -1;
  (prj.cells || []).forEach(({ n, t: label, r: rings, l: lb, f }) => {
    const l = levelIn(prj, map, n, asof);
    c.beginPath();
    rings.forEach((p) => { c.moveTo(p[0] * s, head + p[1] * s); for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * s, head + p[i + 1] * s); c.closePath(); });
    if (l) { c.globalAlpha = 0.45; c.fillStyle = colorOf(l); c.fill("evenodd"); }
    c.globalAlpha = 0.7; c.strokeStyle = "#7030A0"; c.lineWidth = 2; c.setLineDash([10, 8]); c.stroke(); c.setLineDash([]);
    c.globalAlpha = 0.75; c.fillStyle = "#4a1d6e"; c.font = `${Math.max(14, f * s * 0.8)}px Arial`; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText("O" + label, lb[0] * s, head + lb[1] * s); c.globalAlpha = 1;
  });
  prj.geo.forEach(({ n, p, l: lb, a, f }) => {
    const l = levelIn(prj, map, n, asof);
    c.beginPath(); c.moveTo(p[0] * s, head + p[1] * s);
    for (let i = 2; i < p.length; i += 2) c.lineTo(p[i] * s, head + p[i + 1] * s);
    c.closePath();
    c.globalAlpha = l === 0 ? 0.55 : 0.72; c.fillStyle = colorOf(l); c.fill();
    c.globalAlpha = 0.6; c.strokeStyle = "#334155"; c.lineWidth = 1.5; c.stroke();
    c.globalAlpha = 1; c.fillStyle = "#0f172a";
    c.font = `bold ${Math.max(14, f * s)}px Arial`; c.textAlign = "center"; c.textBaseline = "middle";
    c.save(); c.translate(lb[0] * s, head + lb[1] * s); if (a) c.rotate((a * Math.PI) / 180); c.fillText(n, 0, 0); c.restore();
  });
  // Tiêu đề
  c.fillStyle = "#111"; c.textAlign = "center"; c.textBaseline = "alphabetic";
  c.font = "bold 58px Arial"; c.fillText(prj.title, W / 2, 72);
  c.font = "34px Arial"; c.textAlign = "left";
  c.fillText(`Công trình: ${prj.congTrinh}`, 40, 130); c.fillText(`Địa điểm: ${prj.diaDiem}`, 40, 172);
  c.textAlign = "right"; c.font = "bold 38px Arial"; c.fillText(`Ngày: ${fmt(asof)}`, W - 40, 130);
  const total = prj.geo.length;
  const pct = (i) => { const p = tot[i] ? Math.round((cnt[i] / tot[i]) * 100) : 0; return i === cs ? `${cnt[i]}/${tot[i]} ô (${p}%)` : `${cnt[i]} (${p}%)`; };
  const totalTxt = prj.cells ? `${total} ${U(prj)} · ${prj.cells.length} ô` : String(total);
  c.strokeStyle = "#333"; c.lineWidth = 2;

  if (side) {
    const x0 = panelX, pw = W - 40 - x0;
    let y = head + 40;
    // Ghi chú màu (2 cột)
    c.fillStyle = "#111"; c.textAlign = "left"; c.font = "bold 40px Arial"; c.fillText("GHI CHÚ", x0, y + 30);
    y += 60;
    const colW2 = pw / 2, rowH = 64;
    const VS = prjSteps(prj);
    VS.map((i) => STEPS[i]).forEach((st, i) => {
      const cx = x0 + (i % 2) * colW2, cy = y + Math.floor(i / 2) * rowH;
      c.globalAlpha = 0.8; c.fillStyle = st.color; c.fillRect(cx, cy + 10, 110, 44); c.globalAlpha = 1;
      c.strokeRect(cx, cy + 10, 110, 44);
      c.fillStyle = "#111"; c.font = "34px Arial"; c.fillText(st.name, cx + 130, cy + 44);
    });
    y += rowH * Math.ceil(VS.length / 2) + 60;
    // Tổng số
    c.font = "bold 40px Arial"; c.fillText("TỔNG HỢP", x0, y + 30); y += 60;
    c.strokeRect(x0, y, pw, 130); c.beginPath(); c.moveTo(x0, y + 62); c.lineTo(x0 + pw, y + 62); c.stroke();
    c.textAlign = "center"; c.font = "bold 36px Arial"; c.fillText(prj.cells ? `Tổng số ${U(prj)} / ô lấp đất` : `Tổng số ${U(prj)}`, x0 + pw / 2, y + 45);
    c.font = "bold 44px Arial"; c.fillText(totalTxt, x0 + pw / 2, y + 112);
    y += 170;
    // Bảng công tác: tên (tô màu) | số lượng (%) + thanh tiến độ
    const rh = 92, nameW = pw * 0.48;
    VS.forEach((i, k) => {
      const st = STEPS[i], ry = y + k * rh;
      c.globalAlpha = 0.75; c.fillStyle = st.color; c.fillRect(x0, ry, nameW, rh); c.globalAlpha = 1;
      c.strokeRect(x0, ry, pw, rh); c.beginPath(); c.moveTo(x0 + nameW, ry); c.lineTo(x0 + nameW, ry + rh); c.stroke();
      c.fillStyle = "#111"; c.textAlign = "left"; c.font = "bold 36px Arial"; c.fillText(st.name, x0 + 20, ry + 58);
      c.textAlign = "right"; c.font = "bold 38px Arial"; c.fillText(pct(i), x0 + pw - 20, ry + 50);
      const bx = x0 + nameW + 20, bw = pw - nameW - 40;
      c.fillStyle = "#e5e7eb"; c.fillRect(bx, ry + 66, bw, 12);
      c.fillStyle = st.color; c.fillRect(bx, ry + 66, tot[i] ? bw * cnt[i] / tot[i] : 0, 12);
    });
  } else {
    const VS = prjSteps(prj), NC = VS.length + 1;
    const y0 = head + mapH + 24, colW = (W - 80) / NC;
    c.strokeRect(40, y0, W - 80, 130);
    c.beginPath(); c.moveTo(40, y0 + 60); c.lineTo(W - 40, y0 + 60);
    for (let i = 1; i < NC; i++) { c.moveTo(40 + colW * i, y0); c.lineTo(40 + colW * i, y0 + 130); }
    c.stroke();
    c.textAlign = "center"; c.fillStyle = "#111";
    [prj.cells ? "Tổng số" : `Tổng số ${U(prj)}`, ...VS.map((i) => (i === cs ? STEPS[i].name + " (theo ô)" : STEPS[i].name))].forEach((t, i) => {
      if (i > 0) { c.globalAlpha = 0.75; c.fillStyle = STEPS[VS[i - 1]].color; c.fillRect(40 + colW * i + 1, y0 + 1, colW - 2, 58); c.globalAlpha = 1; }
      c.fillStyle = "#111"; c.font = "bold 32px Arial"; c.fillText(t, 40 + colW * (i + 0.5), y0 + 42);
    });
    c.font = "34px Arial";
    [totalTxt, ...VS.map((i) => pct(i))].forEach((t, i) => c.fillText(t, 40 + colW * (i + 0.5), y0 + 108));
  }
  c.font = "22px Arial"; c.fillStyle = "#666"; c.textAlign = "right";
  c.fillText(`Xuất ${new Date().toLocaleString("vi-VN")} – ${me ? me.name : ""} – dangdvd.github.io/CFTN`, W - 40, cv.height - 14);
  return cv;
}

async function exportPng() {
  try {
    const asof = $("asof").value, cv = await renderPlanCanvas(P, data, asof);
    const a = document.createElement("a"); a.download = `MatBang_${P.excelSheet}_${asof}.png`; a.href = cv.toDataURL("image/png"); a.click();
  } catch (e) { setStatus("Xuất ảnh lỗi: " + e.message, "warn"); }
}

async function exportPdf(all) {
  closePdfMenu();
  const asof = $("asof").value;
  try {
    setStatus("Đang tạo PDF…");
    const lib = await loadScript(JSPDF_URL, "jspdf");
    const list = all ? PROJECTS : PROJECTS.filter((x) => x.id === P.id);
    let doc = null;
    for (const meta of list) {
      setStatus(`Đang tạo PDF – ${meta.name}…`);
      const prj = await loadProject(meta.id);
      const map = prj.id === P.id ? data : await be.getMongAll(prj.id);
      const cv = await renderPlanCanvas(prj, map, asof);
      const land = cv.width >= cv.height, pw = land ? 420 : 297, ph = land ? 297 : 420, m = 8;
      if (!doc) doc = new lib.jsPDF({ orientation: land ? "landscape" : "portrait", unit: "mm", format: "a3", compress: true });
      else doc.addPage("a3", land ? "landscape" : "portrait");
      const k = Math.min((pw - 2 * m) / cv.width, (ph - 2 * m) / cv.height), w = cv.width * k, h = cv.height * k;
      doc.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", (pw - w) / 2, (ph - h) / 2, w, h, undefined, "FAST");
    }
    doc.setProperties({ title: all ? "Tiến độ thi công móng & đà kiềng – tất cả mặt bằng" : `${P.name} – ${fmt(asof)}`, creator: "CFTN" });
    doc.save(all ? `TienDo_TatCa_${asof}.pdf` : `MatBang_${P.excelSheet}_${asof}.pdf`);
    setStatus(online ? "Trực tuyến" : "Đã xuất PDF", "ok");
  } catch (e) { setStatus("Xuất PDF lỗi: " + (e.code === "permission-denied" ? "không có quyền đọc" : e.message), "warn"); }
}
function openPdfMenu(e) {
  e.stopPropagation();
  const m = $("pdfMenu"); m.hidden = !m.hidden;
  if (!m.hidden) {
    const r = $("pdfBtn").getBoundingClientRect();
    m.classList.add("fixed");
    m.style.top = r.bottom + 4 + "px";
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + "px";
    m.style.right = "auto";
  }
}
function closePdfMenu() { $("pdfMenu").hidden = true; }

// ---------- Quản lý người dùng ----------
function openUsers() {
  $("usersDlg").hidden = false; $("usersMsg").textContent = "";
  if (!unsubRoles) unsubRoles = be.watchRoles(renderUsers, (e) => { $("usersMsg").textContent = "Lỗi: " + (e.code || e.message); });
}
function closeUsers() { $("usersDlg").hidden = true; }
const RSEL = { none: "Không", viewer: "Chỉ xem", editor: "Cập nhật", admin: "Quản trị" };
function allHouses() {
  const out = [];
  ALL_PROJECTS.forEach((x) => { const k = houseKey(x.id); if (!out.some((h) => h.k === k)) out.push({ k, name: splitName(x.name)[0] }); });
  return out;
}
const openRows = new Set();
let usersList = [];
function roleSummary(u) {
  const hs = allHouses(), def = u.role || "none", ov = u.houses || {};
  const diff = hs.filter((h) => ov[h.k] && ov[h.k] !== def);
  if (!diff.length) return def === "none" ? "Chưa có quyền" : `${RSEL[def]} – tất cả nhà`;
  return `${def === "none" ? "" : RSEL[def] + " (mặc định); "}` + diff.map((h) => `${h.name}: ${RSEL[ov[h.k]]}`).join("; ");
}
function renderUsers(list) {
  usersList = list;
  const owners = OWNER_EMAILS.map((x) => x.toLowerCase()), hs = allHouses();
  list.sort((a, b) => a.email.localeCompare(b.email));
  const opt = (sel, withInherit) => (withInherit ? [["", "Theo mặc định"]] : []).concat(Object.entries(RSEL))
    .map(([k, v]) => `<option value="${k}"${(sel || "") === k ? " selected" : ""}>${v}</option>`).join("");
  let h = `<tr><th>Email</th><th>Tên</th><th>Quyền mặc định<br><small class="muted">(áp dụng mọi nhà)</small></th><th>Theo từng nhà</th><th></th></tr>`;
  owners.forEach((o) => { h += `<tr><td class="em">${esc(o)}</td><td>Chủ hệ thống</td><td>Quản trị</td><td class="muted small">Toàn quyền</td><td></td></tr>`; });
  list.filter((u) => !owners.includes(u.email)).forEach((u) => {
    const em = esc(u.email), open = openRows.has(u.email);
    h += `<tr><td class="em">${em}</td><td>${esc(u.name || "")}</td>` +
      `<td><select data-def="${em}">${opt(u.role || "none", false)}</select></td>` +
      `<td><button class="link" data-tog="${em}">${open ? "▾" : "▸"} ${esc(roleSummary(u))}</button></td>` +
      `<td><button class="x" data-del="${em}" title="Xoá người dùng">×</button></td></tr>`;
    if (open) {
      h += `<tr class="sub"><td colspan="5"><div class="hgrid">` + hs.map((x) =>
        `<label><span>${esc(x.name)}</span><select data-em="${em}" data-h="${x.k}">${opt((u.houses || {})[x.k], true)}</select></label>`).join("") +
        `</div><div class="muted small">"Theo mặc định" = dùng quyền mặc định ở cột bên trái. Chọn "Không" để chặn riêng nhà đó.</div></td></tr>`;
    }
  });
  $("usersTbl").innerHTML = h;
  const save = async (email, patch, msg) => {
    const u = usersList.find((x) => x.email === email) || {};
    const doc = { role: u.role || "none", name: u.name || "", houses: { ...(u.houses || {}) }, by: me.email, at: new Date().toISOString(), ...patch };
    Object.keys(doc.houses).forEach((k) => { if (!doc.houses[k]) delete doc.houses[k]; });
    try { await be.setRole(email, doc); $("usersMsg").textContent = msg; }
    catch (e) { $("usersMsg").textContent = "Lỗi: " + (e.code || e.message); }
  };
  $("usersTbl").querySelectorAll("[data-def]").forEach((s) => { s.onchange = () => save(s.dataset.def, { role: s.value }, "Đã đổi quyền mặc định."); });
  $("usersTbl").querySelectorAll("select[data-h]").forEach((s) => {
    s.onchange = () => {
      const u = usersList.find((x) => x.email === s.dataset.em) || {};
      const hsMap = { ...(u.houses || {}) }; if (s.value) hsMap[s.dataset.h] = s.value; else delete hsMap[s.dataset.h];
      save(s.dataset.em, { houses: hsMap }, "Đã đổi quyền theo nhà.");
    };
  });
  $("usersTbl").querySelectorAll("[data-tog]").forEach((b) => {
    b.onclick = () => { const e = b.dataset.tog; openRows.has(e) ? openRows.delete(e) : openRows.add(e); renderUsers(usersList); };
  });
  $("usersTbl").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Xoá?"; b.style.color = "#d92d20"; b.style.fontSize = "12px"; return; }
      try { await be.deleteRole(b.dataset.del); $("usersMsg").textContent = "Đã xoá người dùng."; }
      catch (e) { $("usersMsg").textContent = "Lỗi: " + (e.code || e.message); }
    };
  });
}
async function addUser(e) {
  e.preventDefault();
  const email = $("newEmail").value.trim().toLowerCase(), name = $("newName").value.trim(), r = $("newRole").value;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("usersMsg").textContent = "Email không hợp lệ."; return; }
  try {
    await be.setRole(email, { role: r, name, houses: {}, by: me.email, at: new Date().toISOString() });
    if (r === "none") openRows.add(email);
    $("usersMsg").textContent = `Đã thêm ${email} (${RSEL[r]}${r === "none" ? " – hãy chọn quyền theo từng nhà bên dưới" : " – tất cả nhà"}).`; $("addUser").reset();
  } catch (err) { $("usersMsg").textContent = "Lỗi: " + (err.code || err.message); }
}

boot();
