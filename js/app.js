import { OWNER_EMAILS } from "./config.js";
import { initWeekly } from "./weekly.js?v=20261122e";

// ===================== Hằng số =====================
const STEPS = [
  { name: "Đào đất",     color: "#908700" },
  { name: "Bê tông lót", color: "#00B0F0" },
  { name: "Cốt thép",    color: "#C00000" },
  { name: "Cốp pha",     color: "#FFC000" },
  { name: "Đổ bê tông",  color: "#00B050" },
  { name: "Lấp đất",     color: "#7030A0" },
  // Công tác của ô sàn (mặt bằng có prj.cellTypes). slot = vị trí lưu trong mảng d[6] của ô
  // (ô sàn không có Đào đất nên ô 0 dùng cho Đá 0x4 / Lát gạch con sâu)
  { name: "Đá 0x4",           color: "#7F7F7F", slot: 0 },
  { name: "Lát gạch con sâu", color: "#C55A11", slot: 0 },
  { name: "Bê tông lót sàn",  color: "#00B0F0", slot: 1 },
  { name: "Cốt thép sàn",     color: "#C00000", slot: 2 },
  { name: "Cốp pha sàn",      color: "#FFC000", slot: 3 },
  { name: "Đổ bê tông sàn",   color: "#00B050", slot: 4 },
];
// Tên công tác có thể đặt riêng theo mặt bằng: prj.stepNames = {chỉ số: "tên"}
const BASE_NAMES = STEPS.map((s) => s.name);
function useStepNames(prj) { STEPS.forEach((s, i) => (s.name = (prj && prj.stepNames && prj.stepNames[i]) || BASE_NAMES[i])); }
// Vị trí lưu ngày của công tác i trong mảng d
const SLOT = (i) => (STEPS[i].slot ?? i);
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
let multi = false, boxMode = false;
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
// Công tác theo dõi của mặt bằng (prj.steps), mặc định 6 công tác đầu
const prjSteps = (prj) => (prj && prj.steps) || ALL_STEPS;
// Ô sàn có thể chia loại (cell.k) với trình tự công tác riêng: prj.cellTypes = {"": [...], "A": [...], …}
function cellOf(n, prj) {
  prj = prj || P;
  if (!prj._c) { prj._c = {}; (prj.cells || []).forEach((c) => (prj._c[c.n] = c)); }
  return prj._c[n] || {};
}
function cellStepsOf(prj, n) {
  if (prj.cellTypes) return prj.cellTypes[cellOf(n, prj).k || ""] || prj.cellTypes[""];
  return [prj.cellStep ?? 5];
}
function cellStepSet(prj) {
  if (!prj || !prj.cells) return new Set();
  if (!prj._cs) prj._cs = new Set(prj.cellTypes ? Object.values(prj.cellTypes).flat() : [prj.cellStep ?? 5]);
  return prj._cs;
}
const isCellStep = (prj, i) => cellStepSet(prj).has(i);
function stepsFor(prj, n) {
  if (!prj) return ALL_STEPS;
  const base = prjSteps(prj);
  if (!prj.cells) return base;
  return isCell(n) ? cellStepsOf(prj, n) : base.filter((i) => !isCellStep(prj, i));
}
const dateOf = (d, i) => (d ? d[SLOT(i)] || null : null);
// Công tác cao nhất (theo trình tự của cấu kiện) đã xong tới ngày asof; trả về chỉ số công tác + 1
function levelIn(prj, map, n, asof) {
  const d = (map[n] && map[n].d) || [], st = stepsFor(prj, n);
  for (let k = st.length - 1; k >= 0; k--) { const i = st[k], v = dateOf(d, i); if (v && (!asof || v <= asof)) return i + 1; }
  return 0;
}
// Công tác s của cấu kiện n đã xong (tính cả các công tác đứng trước công tác cao nhất đã xong)
function doneIn(prj, map, n, s, asof) {
  const l = levelIn(prj, map, n, asof); if (!l) return false;
  const st = stepsFor(prj, n), k = st.indexOf(s);
  return k >= 0 && k <= st.indexOf(l - 1);
}
const cellWord = (prj) => ((prj || P).cellTypes ? "ô sàn" : "ô lấp đất");
function level(n, asof) { return levelIn(P, data, n, asof); }
// Số hiệu hiển thị của ô (id giữ cố định để dữ liệu không lệch khi bỏ bớt ô)
function cellLabel(n, prj) {
  prj = prj || P;
  if (!prj._cl) { prj._cl = {}; (prj.cells || []).forEach((c) => (prj._cl[c.n] = c.t)); }
  return prj._cl[n] || n.slice(1);
}
// Cấu kiện có thể có tên hiển thị riêng (g.t, vd "GB1-1", "V3") và loại riêng (g.u, vd "vách")
function geoOf(n, prj) {
  prj = prj || P;
  if (!prj._g) { prj._g = {}; prj.geo.forEach((g) => (prj._g[g.n] = g)); }
  return prj._g[n] || {};
}
const geoLabel = (n, prj) => geoOf(n, prj).t || n;
const shortLabel = (n, prj) => (isCell(n) ? "O" + cellLabel(n, prj) : geoLabel(n, prj));
function itemName(n, prj) {
  if (isCell(n)) return `O${cellLabel(n, prj)}`;
  const g = geoOf(n, prj), u = g.u || U(prj);
  return `${u.charAt(0).toUpperCase() + u.slice(1)} ${g.t || n}`;
}
const sortKey = (n) => (isCell(n) ? 100000 + Number(cellLabel(n)) : Number(n));
// Đường SVG cho ô có nhiều vòng (vòng ngoài + lỗ móng), tô theo evenodd
function ringsPath(rings) {
  return rings.map((p) => { let d = `M${p[0]},${p[1]}`; for (let i = 2; i < p.length; i += 2) d += `L${p[i]},${p[i + 1]}`; return d + "Z"; }).join("");
}
// Thống kê: cnt[i] = số cấu kiện đã xong công tác i (cộng dồn), tot[i] = tổng số cấu kiện của công tác i
function statsIn(prj, map, asof) {
  const cnt = STEPS.map(() => 0), tot = STEPS.map(() => 0);
  prj.geo.map((g) => g.n).concat((prj.cells || []).map((c) => c.n)).forEach((n) => {
    const l = levelIn(prj, map, n, asof), st = stepsFor(prj, n), kl = l ? st.indexOf(l - 1) : -1;
    // l là công tác cao nhất đã xong; các công tác đứng trước nó (theo trình tự) coi như đã xong
    st.forEach((i, k) => { tot[i]++; if (k <= kl) cnt[i]++; });
  });
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
    be = await import("./backend.js?v=20261122e");
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
  if (WK) WK.stop();
}

// ===================== Ứng dụng =====================
let built = false;
// Tên mặt bằng dạng "Nhà … – Móng" → [nhà, loại mặt bằng]
function splitName(n) { const i = n.lastIndexOf(" – "); return i < 0 ? [n, ""] : [n.slice(0, i), n.slice(i + 3)]; }
const KIND_ORDER = ["Móng", "Móng bể nước", "Đà kiềng", "Dầm sàn tầng 1", "Cổ cột", "Cột tầng 1", "Vách tầng 1"];
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
  multi = false; setBox(false); $("multiBtn").classList.remove("on"); setSheet(false);
  try { P = await loadProject(id); } catch (e) { setStatus("Không tải được mặt bằng", "warn"); return; }
  useStepNames(P);
  if (location.hash.replace("#", "") !== P.id) history.replaceState(null, "", "#" + P.id);
  syncSelectors(P.id);
  applyRole();
  $("multiBtn").textContent = P.cells ? "Chọn nhiều" : `Chọn nhiều ${U()}`;
  $("pTitle").textContent = P.title; $("pCT").textContent = P.congTrinh; $("pDD").textContent = P.diaDiem;
  document.title = P.name + " – " + P.title;
  buildMap(); requestAnimationFrame(() => fit(isMobile()));
  paint(); renderPanel();
  WK.onProject();
  setStatus("Đang tải dữ liệu…");
  const timer = setTimeout(() => setStatus("Chưa kết nối được dữ liệu – đang thử lại…", "warn"), 10000);
  const pid = P.id;
  unsubMong = be.watchMong(pid, (d, fromCache) => {
    if (!P || P.id !== pid) return;
    data = remapData(P, d);
    if (!fromCache) migrateRemap(d);
    if (!fromCache && !online) { clearTimeout(timer); online = true; setStatus("Trực tuyến", "ok"); }
    if (!saving) { paint(); renderPanel(); WK.onData(); }
  }, (err) => { clearTimeout(timer); setStatus("Lỗi dữ liệu: " + (err.code || err.message), "warn"); });
}

// ---------- Đánh số lại cấu kiện ----------
// prj.remap = {id, src:{sốMới:[sốCũ ưu tiên, sốCũ dự phòng]}}. Khi chưa chuyển dữ liệu, hiển thị theo số mới
// bằng cách lấy dữ liệu từ số cũ; người có quyền cập nhật mở mặt bằng sẽ chuyển hẳn dữ liệu 1 lần (kèm dấu "_id").
// prj.remap = [{id, keys:{g:số đà kiềng, c:số ô}, src:{sốMới:[sốCũ…]}, upto:{sốMới:k}}] – các lần đánh số lại theo thứ tự.
// upto[n]=k: cấu kiện gộp, lấy ngày các công tác 0..k-1 từ các số cũ, các công tác sau để trống.
const remapList = (prj) => (prj && prj.remap ? [].concat(prj.remap) : []);
function remapStage(R, d) {
  const out = {}, keys = [];
  for (let i = 1; i <= R.keys.g; i++) keys.push(String(i));
  const ck = new Set(Object.keys(d).concat(Object.keys(R.src)).filter((k) => k[0] === "O"));
  for (let i = 1; i <= (R.keys.c || 0); i++) ck.add("O" + i);
  keys.push(...ck);
  keys.forEach((n) => {
    const cand = R.src[n] || [n];
    const k = R.upto && R.upto[n];
    if (k !== undefined) {
      const recs = cand.map((c) => d[c]).filter(Boolean), all = recs.flatMap((r) => norm(r.d)).filter(Boolean).sort();
      const fb = all.length ? all[all.length - 1] : new Date().toISOString().slice(0, 10);
      const nd = norm([]).map((_, i) => (i < k ? recs.map((r) => norm(r.d)[i]).find(Boolean) || fb : null));
      const base = recs[0] || {};
      out[n] = { d: nd, by: base.by || "", byName: base.byName || "", at: base.at || new Date().toISOString(),
        h: [].concat(...recs.map((r) => r.h || [])).sort((x, y) => (x.at || "").localeCompare(y.at || "")).slice(-30) };
      return;
    }
    const s = cand.find((c) => d[c] && norm(d[c].d).some(Boolean));
    if (s !== undefined) out[n] = d[s];
  });
  return out;
}
function remapData(prj, d) {
  let cur = d;
  remapList(prj).forEach((R) => { if (!d["_" + R.id]) cur = remapStage(R, cur); });
  return cur;
}
let migrating = false;
async function migrateRemap(raw) {
  const L = remapList(P), pid = P && P.id;
  const todo = L.filter((R) => !raw["_" + R.id]);
  if (!todo.length || migrating || !me || !canEdit()) return;
  migrating = true;
  try {
    const now = new Date().toISOString(), m = remapData(P, raw);
    const empty = () => ({ d: norm([]), by: me.uid, byName: me.name || "", at: now, h: [] });
    const entries = [];
    P.geo.map((g) => g.n).concat((P.cells || []).map((c) => c.n)).forEach((n) => {
      const nv = m[n], ov = raw[n];
      if (nv === ov) return;
      if (!nv && !(ov && norm(ov.d).some(Boolean))) return;
      entries.push([n, nv ? { d: norm(nv.d), by: me.uid, byName: nv.byName || "", at: nv.at || now, h: (nv.h || []).slice(-30) } : empty()]);
    });
    todo.forEach((R) => entries.push(["_" + R.id, empty()]));
    await be.saveMongMany(pid, entries);
  } catch (e) { console.warn("Chuyển số liệu lỗi", e); }
  migrating = false;
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
  P.geo.forEach(({ n, t: lbl, p, l, a, f }) => {
    const g = document.createElementNS(NS, "g"); g.setAttribute("class", "mong"); g.dataset.n = n;
    const r = document.createElementNS(NS, "polygon");
    const pts = []; for (let i = 0; i < p.length; i += 2) pts.push(p[i] + "," + p[i + 1]);
    r.setAttribute("points", pts.join(" "));
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", l[0]); t.setAttribute("y", l[1]); t.setAttribute("font-size", f);
    if (a) t.setAttribute("transform", `rotate(${a} ${l[0]} ${l[1]})`);
    t.textContent = lbl || n;
    const tt = document.createElementNS(NS, "title");
    g.append(tt, r, t); svg.appendChild(g);
    nodes[n] = { g, r, tt };
  });
  vb.w = P.width; vb.h = P.height; setVB();
  WK.drawZones();
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
  const asof = $("asof").value, { cnt, tot } = statsIn(P, data, asof);
  $("statDate").textContent = fmt(asof);
  let h = `<tr><td>Tổng số ${U()}</td><td>${P.geo.length}</td></tr>`;
  if (P.cells) h += `<tr><td>Tổng số ${cellWord()}</td><td>${P.cells.length}</td></tr>`;
  prjSteps(P).forEach((i) => {
    const s = STEPS[i], cs = isCellStep(P, i);
    const p = tot[i] ? Math.round((cnt[i] / tot[i]) * 100) : 0;
    const v = cs ? `${cnt[i]}/${tot[i]} ô (${p}%)` : `${cnt[i]} (${p}%)`;
    h += `<tr><td>${s.name}${cs ? " <small class=\"muted\">(theo ô)</small>" : ""}<div class="bar"><i style="width:${p}%;background:${s.color}"></i></div></td><td>${v}</td></tr>`;
  });
  $("stats").innerHTML = h;
  updateHandle();
}

// ---------- Phóng to / di chuyển ----------
function fit(cover) {
  const r = $("map").getBoundingClientRect(); if (!r.width || !r.height) return;
  lastBox = { w: r.width, h: r.height }; fitted = cover ? "cover" : "fit";
  const ar = r.width / r.height, iar = P.width / P.height;
  if (cover === true && ar < iar) { vb.h = P.height; vb.w = P.height * ar; vb.x = (P.width - vb.w) / 2; vb.y = 0; setVB(); return; }
  if (ar > iar) { vb.h = P.height; vb.w = P.height * ar; vb.x = -(vb.w - P.width) / 2; vb.y = 0; }
  else { vb.w = P.width; vb.h = P.width / ar; vb.y = -(vb.h - P.height) / 2; vb.x = 0; }
  setVB();
}
function zoomAt(f, cx, cy) {
  fitted = false;
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
  if (window.ResizeObserver) new ResizeObserver(onMapResize).observe(svg);
  else window.addEventListener("resize", onMapResize);
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
  $("zin").onclick = () => centerZoom(1.4);
  $("zout").onclick = () => centerZoom(1 / 1.4);
  $("zfit").onclick = () => fit(false);

  // Kéo 1 ngón = di chuyển; 2 ngón = phóng to quanh tâm 2 ngón + di chuyển theo tâm.
  // Mỗi khi số ngón thay đổi, gesture được đặt lại từ vị trí hiện tại → không bị nhảy khi nhấc 1 ngón.
  const ptrs = new Map(); let moved = false, gest = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function resetGesture(e) {
    const a = [...ptrs.values()];
    hideBox();
    // Tab Kế hoạch tuần – Sửa vùng: kéo đỉnh / di chuyển vùng
    if (a.length === 1 && e && e.type === "pointerdown" && WK.active) {
      const wg = WK.down(toSvgPt(a[0].x, a[0].y), e);
      if (wg) { gest = { type: "wk", wg, x: a[0].x, y: a[0].y }; return; }
    }
    // Tab Kế hoạch tuần: kéo khung để khoanh vùng chữ nhật
    if (a.length === 1 && e && e.type === "pointerdown" && WK.wantsRect()) { gest = { type: "zrect", x: a[0].x, y: a[0].y }; return; }
    // Quét chọn: bật nút "Quét chọn", hoặc giữ Ctrl/Shift khi kéo chuột (Alt = bỏ chọn)
    if (a.length === 1 && e && e.type === "pointerdown" && canEdit() && (boxMode || (e.pointerType === "mouse" && (e.ctrlKey || e.shiftKey))))
      gest = { type: "box", x: a[0].x, y: a[0].y, rm: e.altKey };
    else if (a.length === 1) gest = { type: "pan", x: a[0].x, y: a[0].y, vx: vb.x, vy: vb.y };
    else if (a.length >= 2) gest = { type: "pinch", d: dist(a[0], a[1]), mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2 };
    else gest = null;
  }
  svg.addEventListener("pointerdown", (e) => {
    try { svg.setPointerCapture(e.pointerId); } catch (x) {}
    if (ptrs.size === 0) moved = false;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) moved = true;
    resetGesture(e);
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
    if (gest.type === "wk") {
      if (!moved && Math.hypot(e.clientX - gest.x, e.clientY - gest.y) > 3) moved = true;
      if (moved) WK.move(gest.wg, toSvgPt(e.clientX, e.clientY));
      return;
    }
    if (gest.type === "box" || gest.type === "zrect") {
      if (!moved && Math.hypot(e.clientX - gest.x, e.clientY - gest.y) > 6) moved = true;
      if (moved) { drawBox(gest, e.clientX, e.clientY); if (gest.type === "zrect") $("selbox").setAttribute("class", "zonebox"); }
      return;
    }
    if (gest.type === "pan") {
      const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
      if (!moved && Math.hypot(dx, dy) > 6) { moved = true; svg.classList.add("dragging"); }
      if (moved) { fitted = false; vb.x = gest.vx - (dx / r.width) * vb.w; vb.y = gest.vy - (dy / r.height) * vb.h; setVB(); }
    }
  });
  const endPtr = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const tap = ptrs.size === 1 && !moved && e.type === "pointerup";
    if (gest && gest.type === "box" && moved && ptrs.size === 1 && e.type === "pointerup") boxSelect(gest, e.clientX, e.clientY);
    if (gest && gest.type === "wk" && ptrs.size === 1) WK.up(gest.wg, moved && e.type === "pointerup");
    if (gest && gest.type === "zrect" && moved && ptrs.size === 1 && e.type === "pointerup") {
      hideBox(); const a = toSvgPt(gest.x, gest.y), b = toSvgPt(e.clientX, e.clientY); WK.addRect(a, b);
    }
    ptrs.delete(e.pointerId);
    if (tap && WK.active) WK.tap(toSvgPt(e.clientX, e.clientY));
    else if (tap) {
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
    if (WK.drawing()) return;
    if (now - lastTap < 300) { zoomAt(2, e.clientX, e.clientY); lastTap = 0; } else lastTap = now;
  });

  $("boxBtn").onclick = () => {
    setBox(!boxMode);
    if (boxMode && !multi) { multi = true; $("multiBtn").classList.add("on"); if (isMobile()) setSheet(false); paint(); renderPanel(); }
  };
  $("multiBtn").onclick = () => {
    multi = !multi; $("multiBtn").classList.toggle("on", multi);
    if (!multi) setBox(false);
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
  document.querySelectorAll(".viewtabs button").forEach((b) => (b.onclick = () => WK.setActive(b.dataset.view === "week")));
  WK.bind();
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

// ---------- Quét chọn kiểu AutoCAD ----------
// Kéo trái → phải (khung liền xanh dương): chọn cấu kiện nằm trọn trong khung (Window).
// Kéo phải → trái (khung nét đứt xanh lá): chọn cấu kiện chạm khung (Crossing).
function setBox(on) {
  boxMode = !!on;
  const b = $("boxBtn"); if (b) b.classList.toggle("on", boxMode);
  $("map").classList.toggle("boxmode", boxMode);
  updateHandle();
}
// Đổi toạ độ màn hình → toạ độ mặt bằng theo ma trận thực của SVG (đúng cả khi khung bị co giãn)
function toSvgPt(cx, cy) {
  const svg = $("map"), m = svg.getScreenCTM();
  if (m) { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; const q = pt.matrixTransform(m.inverse()); return { x: q.x, y: q.y }; }
  const r = svg.getBoundingClientRect();
  return { x: vb.x + ((cx - r.left) / r.width) * vb.w, y: vb.y + ((cy - r.top) / r.height) * vb.h };
}
// Khung mặt bằng đổi kích thước (bật tab Kế hoạch tuần, kéo cửa sổ, xoay điện thoại):
// giữ tâm và tỉ lệ đang xem, chỉnh viewBox cho khớp tỉ lệ khung mới để chuột/ngón tay không bị lệch
let lastBox = null, fitted = false;
function onMapResize() {
  const r = $("map").getBoundingClientRect();
  if (!r.width || !r.height || !P) return;
  // đang xem vừa màn hình → thu vừa lại theo khung mới; đã phóng to/di chuyển → giữ nguyên chỗ đang xem
  if (fitted) { fit(fitted === "cover"); return; }
  if (lastBox && lastBox.w && lastBox.h) {
    const k = vb.w / lastBox.w, cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    vb.w = r.width * k; vb.h = r.height * k; vb.x = cx - vb.w / 2; vb.y = cy - vb.h / 2; setVB();
  }
  lastBox = { w: r.width, h: r.height };
}
function hideBox() { const b = document.getElementById("selbox"); if (b) b.remove(); }
function drawBox(g, cx, cy) {
  const svg = $("map"); let b = document.getElementById("selbox");
  if (!b) { b = document.createElementNS(NS, "rect"); b.id = "selbox"; b.setAttribute("vector-effect", "non-scaling-stroke"); svg.appendChild(b); }
  const a = toSvgPt(g.x, g.y), c = toSvgPt(cx, cy), cross = cx < g.x;
  b.setAttribute("x", Math.min(a.x, c.x)); b.setAttribute("y", Math.min(a.y, c.y));
  b.setAttribute("width", Math.abs(c.x - a.x)); b.setAttribute("height", Math.abs(c.y - a.y));
  b.setAttribute("class", cross ? "cross" : "win");
}
function polysOf(n) {
  if (isCell(n)) { const c = (P.cells || []).find((q) => q.n === n); return c ? [c.r[0]] : []; }
  const g = geoOf(n); return g.p ? [g.p] : [];
}
function inPoly(x, y, p) {
  let ins = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function segX(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
function polyHit(p, R, cross) {
  const pts = []; for (let i = 0; i < p.length; i += 2) pts.push({ x: p[i], y: p[i + 1] });
  const inR = (q) => q.x >= R.x0 && q.x <= R.x1 && q.y >= R.y0 && q.y <= R.y1;
  if (!cross) return pts.every(inR);
  if (pts.some(inR)) return true;
  const rc = [{ x: R.x0, y: R.y0 }, { x: R.x1, y: R.y0 }, { x: R.x1, y: R.y1 }, { x: R.x0, y: R.y1 }];
  if (rc.some((q) => inPoly(q.x, q.y, p))) return true;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let k = 0; k < 4; k++) if (segX(a, b, rc[k], rc[(k + 1) % 4])) return true;
  }
  return false;
}
function boxSelect(g, cx, cy) {
  hideBox();
  const a = toSvgPt(g.x, g.y), c = toSvgPt(cx, cy), cross = cx < g.x;
  const R = { x0: Math.min(a.x, c.x), x1: Math.max(a.x, c.x), y0: Math.min(a.y, c.y), y1: Math.max(a.y, c.y) };
  const ids = P.geo.map((q) => q.n).concat((P.cells || []).map((q) => q.n));
  const hit = ids.filter((n) => polysOf(n).some((p) => polyHit(p, R, cross)));
  if (!multi) { multi = true; $("multiBtn").classList.add("on"); }
  hit.forEach((n) => (g.rm ? sel.delete(n) : sel.add(n)));
  paint(); renderPanel();
  if (hit.length) msg(`${g.rm ? "Bỏ chọn" : "Đã chọn thêm"} ${hit.length} cấu kiện (${cross ? "chạm khung" : "nằm trọn trong khung"})`, true);
}

const isMobile = () => window.matchMedia("(max-width:820px)").matches;
// iPhone tự phóng to trang khi bấm vào ô nhập; nhập xong thì đặt lại tỉ lệ để thanh công cụ không bị đẩy ra ngoài màn hình
document.addEventListener("focusout", (e) => {
  if (!isMobile() || !e.target.matches || !e.target.matches("input,select,textarea")) return;
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a.matches && a.matches("input,select,textarea")) return; // đang chuyển sang ô nhập khác
    const m = document.querySelector('meta[name="viewport"]'); if (!m) return;
    const c = m.getAttribute("content");
    m.setAttribute("content", c.replace(/maximum-scale=[\d.]+/, "maximum-scale=1.01"));
    requestAnimationFrame(() => { m.setAttribute("content", c); window.scrollTo(0, 0); });
  }, 150);
});
function setSheet(open) { $("aside").classList.toggle("open", !!open); updateHandle(); }
function updateHandle() {
  const t = $("handleText"); if (!t || !P) return;
  if (WK.active) { t.textContent = WK.handleText(); return; }
  if (sel.size === 1 && !multi) {
    const n = [...sel][0], l = level(n, $("asof").value);
    t.textContent = `${itemName(n)} – ${l === 0 ? (isCell(n) ? "Chưa lấp đất" : "Chưa thi công") : STEPS[l - 1].name}`;
  } else if (sel.size > 0) t.textContent = `${sel.size} cấu kiện đã chọn` + (isMobile() && !$("aside").classList.contains("open") ? " – bấm ▲ để cập nhật" : "");
  else if (boxMode && isMobile()) t.textContent = "Quét chọn: kéo 1 ngón để quét, 2 ngón để di chuyển";
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
      (canEdit() ? `<br><br>Muốn cập nhật cả loạt, bật <b>Chọn nhiều</b> rồi bấm lần lượt các ${U()}, hoặc bật <b>Quét chọn</b> rồi kéo khung như AutoCAD: kéo <b>trái → phải</b> chọn cấu kiện nằm trọn trong khung, kéo <b>phải → trái</b> chọn cấu kiện chạm khung. Trên máy tính có thể giữ <b>Ctrl</b> (hoặc Shift) rồi kéo chuột; giữ thêm <b>Alt</b> để bỏ chọn.` : "") +
      `</div><div class="msg" id="msg"></div>`;
    return;
  }
  if (sel.size === 1 && !multi) return renderSingle([...sel][0], ro);
  renderMulti(ro);
}

function renderSingle(n, ro) {
  const panel = $("panel"), r = rec(n), l = level(n, null), ed = canEdit(), allowed = stepsFor(P, n), cell = isCell(n);
  let h = `<div class="selhead"><b>${esc(itemName(n))}</b><small>${l === 0 ? (cell ? "Chưa lấp đất" : "Chưa thi công") : "Đã xong: " + STEPS[l - 1].name}</small></div>${ro}`;
  if (cell && P.cellTypes) { const k = cellOf(n).k; h += `<div class="note info">Ô sàn${k ? " loại <b>" + esc(k) + "</b>" : ""}: ${allowed.map((i) => STEPS[i].name).join(" → ")}.</div>`; }
  else if (cell) h += `<div class="note info">Ô lấp đất giữa các ${U()} – chỉ theo dõi công tác Lấp đất.</div>`;
  else if (P.cells) h += `<div class="muted small" style="margin-bottom:8px">${P.cellTypes ? "Lấp đất và các công tác sàn" : "Lấp đất"} được theo dõi theo từng ô giữa các ${U()}.</div>`;
  h += `<div class="steps">`;
  allowed.forEach((i) => {
    const s = STEPS[i];
    const v = dateOf(r.d, i) || "";
    h += `<div class="step"><i class="sw" style="background:${s.color};opacity:.8"></i><span>${s.name}</span>` +
      `<input type="date" data-i="${i}" value="${v}"${ed ? "" : " disabled"}>` +
      (ed ? `<button class="x" data-i="${i}" title="Xoá ngày">×</button>` : "<span></span>") + `</div>`;
  });
  h += `</div>`;
  if (ed) h += `<div class="actions"><button class="primary" id="save" disabled>Lưu</button><button id="quick">${cell && allowed.length === 1 ? "✓ Đã lấp đất hôm nay" : "✓ Xong công tác tiếp theo hôm nay"}</button></div>`;
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
  const dirty = () => { let ch = false; inputs.forEach((inp) => { if ((inp.value || null) !== dateOf(r.d, +inp.dataset.i)) ch = true; }); saveBtn.disabled = !ch; };
  inputs.forEach((inp) => { inp.oninput = dirty; inp.onchange = dirty; });
  // × xoá ngày của công tác đó (tìm ô nhập theo data-i, vì ô lấp đất chỉ có 1 ô nhập) rồi lưu luôn
  panel.querySelectorAll(".x").forEach((b) => {
    b.onclick = () => {
      const inp = panel.querySelector(`input[type=date][data-i="${b.dataset.i}"]`);
      if (!inp || !inp.value) return;
      inp.value = ""; dirty();
      const nd = norm(r.d); inputs.forEach((x) => (nd[SLOT(+x.dataset.i)] = x.value || null));
      saveMany([n], () => nd);
    };
  });
  saveBtn.onclick = () => { const nd = norm(r.d); inputs.forEach((inp) => (nd[SLOT(+inp.dataset.i)] = inp.value || null)); saveMany([n], () => nd); };
  $("quick").onclick = () => {
    const cur = norm(r.d), l = level(n, null), nx = allowed[l ? allowed.indexOf(l - 1) + 1 : 0];
    if (nx === undefined) { msg(`${itemName(n)} đã hoàn thành tất cả công tác.`); return; }
    cur[SLOT(nx)] = todayStr(); saveMany([n], () => cur);
  };
}

function renderMulti(ro) {
  const panel = $("panel"), list = [...sel].sort((a, b) => sortKey(a) - sortKey(b));
  const allowed = stepsFor(P, list[0]).filter((i) => list.every((n) => stepsFor(P, n).includes(i)));
  let h = `<div class="selhead"><b>${list.length} cấu kiện đã chọn</b><small>bấm để thêm / bỏ</small></div>${ro}`;
  h += `<div class="multi"><div class="chips">${list.map((n) => `<span>${esc(shortLabel(n))}</span>`).join("")}</div>`;
  if (canEdit() && !allowed.length) {
    h += `<div class="note">Đang chọn lẫn ${cellWord()} và ${U()}. Hãy chọn riêng từng loại để cập nhật.</div>`;
  } else if (canEdit()) {
    // Mặc định: công tác hiện tại chung của các cấu kiện đã chọn; nếu khác nhau thì công tác tiếp theo của cấu kiện chậm nhất
    const lv = list.map((n) => level(n, null));
    const same = lv.every((x) => x === lv[0]);
    // vị trí công tác hiện tại của từng cấu kiện trong trình tự chung (-1 = chưa làm)
    const pos = lv.map((l) => (l ? allowed.indexOf(l - 1) : -1));
    let defStep = same && lv[0] > 0 && allowed.includes(lv[0] - 1) ? lv[0] - 1 : allowed[Math.min(Math.min(...pos) + 1, allowed.length - 1)];
    const dates = list.map((n) => dateOf(rec(n).d, defStep));
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
    const i = +$("mStep").value, ds = list.map((n) => dateOf(rec(n).d, i));
    $("mDate").value = ds[0] && ds.every((x) => x === ds[0]) ? ds[0] : todayStr();
  };
  $("mSave").onclick = () => {
    const i = +$("mStep").value, d = $("mDate").value; if (!d) { msg("Chọn ngày trước."); return; }
    saveMany(list, (n) => { const c = norm(rec(n).d); c[SLOT(i)] = d; return c; });
  };
  $("mClear").onclick = () => {
    const i = +$("mStep").value;
    saveMany(list, (n) => { const c = norm(rec(n).d); c[SLOT(i)] = null; return c; });
  };
}

// ---------- Lưu ----------
function makeEntries(existing, list, makeNew, via) {
  const now = new Date().toISOString(), entries = [];
  list.forEach((n) => {
    const old = existing[n] || { d: [], h: [] }, od = norm(old.d), nd = norm(makeNew(n));
    if (JSON.stringify(od) === JSON.stringify(nd)) return;
    const h = (old.h || []).slice();
    const st = stepsFor(P, n), nameAt = (sl) => STEPS[st.find((i) => SLOT(i) === sl) ?? sl].name;
    for (let i = 0; i < 6; i++) if (od[i] !== nd[i]) h.push({ s: nameAt(i), d: nd[i], by: me.uid, byName: me.name, at: now, via: via || null });
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
        const n0 = String(c.v).trim();
        // excelMap: số shape trong file Excel cũ → số cấu kiện mới (khi mặt bằng đã chia/đánh số lại)
        const ns = prj.excelMap ? prj.excelMap[n0] || [] : [n0];
        ns.forEach((n) => { if (known.has(n)) rows[n] = cols.map((k) => cellDate(X, ws[k + r])); });
      }
      const existing = P && prj.id === P.id ? data : remapData(prj, await be.getMongAll(prj.id));
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
      aoa.push([isCell(n) ? "O" + cellLabel(n) : (geoOf(n).u ? itemName(n) : geoOf(n).t || Number(n)), ...VS.map((i) => dateOf(r.d, i)).map((d, k) => (d && d <= asof && allowed.includes(VS[k]) ? { t: "n", v: excelSerial(d), z: "dd/mm/yyyy" } : "")),
        l === 0 ? (isCell(n) ? "Chưa lấp đất" : "Chưa thi công") : STEPS[l - 1].name, r.at ? new Date(r.at).toLocaleString("vi-VN") : "", r.byName || ""]);
    });
    const ws = X.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: P.geo.some((g) => g.t || g.u) ? 14 : 7 }, ...VS.map(() => ({ wch: 12 })), { wch: 16 }, { wch: 20 }, { wch: 22 }];
    const wb = X.utils.book_new(); const sh = P.excelSheet || P.id;
    X.utils.book_append_sheet(wb, ws, sh.slice(0, 31));
    X.writeFile(wb, `TienDo_${sh}_${asof}.xlsx`);
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

// Vẽ ảnh nền mặt bằng tại (ox, oy) với tỉ lệ s; colored = tô màu tiến độ các cấu kiện
async function drawPlanOn(c, prj, map, asof, ox, oy, s, colored) {
  const img = new Image(); img.src = prj.image; await img.decode();
  c.drawImage(img, ox, oy, prj.width * s, prj.height * s);
  if (!colored) return;
  const X = (v) => ox + v * s, Y = (v) => oy + v * s;
  (prj.cells || []).forEach(({ n, t: label, r: rings, l: lb, f }) => {
    const l = levelIn(prj, map, n, asof);
    c.beginPath();
    rings.forEach((p) => { c.moveTo(X(p[0]), Y(p[1])); for (let i = 2; i < p.length; i += 2) c.lineTo(X(p[i]), Y(p[i + 1])); c.closePath(); });
    if (l) { c.globalAlpha = 0.45; c.fillStyle = colorOf(l); c.fill("evenodd"); }
    c.globalAlpha = 0.7; c.strokeStyle = "#7030A0"; c.lineWidth = 2; c.setLineDash([10, 8]); c.stroke(); c.setLineDash([]);
    c.globalAlpha = 0.75; c.fillStyle = "#4a1d6e"; c.font = `${Math.max(14, f * s * 0.8)}px Arial`; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText("O" + label, X(lb[0]), Y(lb[1])); c.globalAlpha = 1;
  });
  prj.geo.forEach(({ n, t: lbl, p, l: lb, a, f }) => {
    const l = levelIn(prj, map, n, asof);
    c.beginPath(); c.moveTo(X(p[0]), Y(p[1]));
    for (let i = 2; i < p.length; i += 2) c.lineTo(X(p[i]), Y(p[i + 1]));
    c.closePath();
    c.globalAlpha = l === 0 ? 0.55 : 0.72; c.fillStyle = colorOf(l); c.fill();
    c.globalAlpha = 0.6; c.strokeStyle = "#334155"; c.lineWidth = 1.5; c.stroke();
    c.globalAlpha = 1; c.fillStyle = "#0f172a";
    c.font = `bold ${Math.max(14, f * s)}px Arial`; c.textAlign = "center"; c.textBaseline = "middle";
    c.save(); c.translate(X(lb[0]), Y(lb[1])); if (a) c.rotate((a * Math.PI) / 180); c.fillText(lbl || n, 0, 0); c.restore();
  });
  c.globalAlpha = 1;
}

// Vẽ mặt bằng đã tô màu + tiêu đề + bảng tổng hợp lên canvas
async function renderPlanCanvas(prj, map, asof) {
  useStepNames(prj);
  try { return await renderPlanCanvasInner(prj, map, asof); } finally { useStepNames(P); }
}
async function renderPlanCanvasInner(prj, map, asof) {
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
  await drawPlanOn(c, prj, map, asof, 0, head, s, true);
  const { cnt, tot } = statsIn(prj, map, asof);
  // Tiêu đề
  c.fillStyle = "#111"; c.textAlign = "center"; c.textBaseline = "alphabetic";
  c.font = "bold 58px Arial"; c.fillText(prj.title, W / 2, 72);
  c.font = "34px Arial"; c.textAlign = "left";
  c.fillText(`Công trình: ${prj.congTrinh}`, 40, 130); c.fillText(`Địa điểm: ${prj.diaDiem}`, 40, 172);
  c.textAlign = "right"; c.font = "bold 38px Arial"; c.fillText(`Ngày: ${fmt(asof)}`, W - 40, 130);
  const total = prj.geo.length;
  const pct = (i) => { const p = tot[i] ? Math.round((cnt[i] / tot[i]) * 100) : 0; return isCellStep(prj, i) ? `${cnt[i]}/${tot[i]} ô (${p}%)` : `${cnt[i]} (${p}%)`; };
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
    c.textAlign = "center"; c.font = "bold 36px Arial"; c.fillText(prj.cells ? `Tổng số ${U(prj)} / ${cellWord(prj)}` : `Tổng số ${U(prj)}`, x0 + pw / 2, y + 45);
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
    [prj.cells ? "Tổng số" : `Tổng số ${U(prj)}`, ...VS.map((i) => (isCellStep(prj, i) && !prj.cellTypes ? STEPS[i].name + " (theo ô)" : STEPS[i].name))].forEach((t, i) => {
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
      const map = prj.id === P.id ? data : remapData(prj, await be.getMongAll(prj.id));
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

// ===================== Tab Kế hoạch – Báo cáo tuần =====================
const WK = initWeekly({
  get P() { return P; }, get data() { return data; }, get be() { return be; }, get me() { return me; },
  get online() { return online; },
  canEdit, $, esc, fmt, todayStr, STEPS, stepsFor, prjSteps, levelIn, doneIn, isCellStep, statsIn, isCell, U, splitName,
  projName: () => (PROJECTS.find((x) => x.id === P.id) || P).name,
  setStatus, loadScript, JSPDF_URL, drawPlanOn, paint, isMobile, setSheet, updateHandle,
  pxToSvg: (px) => { const r = $("map").getBoundingClientRect(); return r.width ? (px * vb.w) / r.width : px; },
  shortLabel, itemName,
  clearSel: () => { sel.clear(); multi = false; setBox(false); $("multiBtn").classList.remove("on"); paint(); renderPanel(); },
});

boot();
