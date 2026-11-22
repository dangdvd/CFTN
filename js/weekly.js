// =====================================================================
//  Tab "Kế hoạch – Báo cáo tuần"
//  - Tuần báo cáo W = [start, start+6]; kế hoạch lập cho tuần tới W+1.
//  - Dữ liệu: projects/{id}/weeks/w{ngày đầu tuần}
//      zones: [{id, n, p:[x,y,…], c?, f?}]  vùng khoanh trên mặt bằng (tuyến); c = màu, f = kiểu tô
//      rows:  [{z, s, n, b, e, kh, th}]     bảng 1: công tác theo vùng
//      t2:    {s: %}                        % kế hoạch của tuần này (bảng 2)
//      res:   [{n, q, g}]                   nhân lực – thiết bị (tuỳ chọn)
//      tA, dA / tB, dB                      tiêu đề, ngày lập của trang kế hoạch / báo cáo
//    projects/{id}/weeks/_cfg: kl: {s: {v, u}}  khối lượng tổng & đơn vị nhập tay
//  - Tab A (kế hoạch tuần tới) sửa tài liệu của tuần W+1.
//  - Tab B (báo cáo tuần W) đọc kế hoạch đã lập cho W, nhập % thực hiện;
//    "% kế hoạch tuần tới" của B chính là t2 của tuần W+1 (cùng 1 số liệu với A).
// =====================================================================

const BLUE = "#1f4e9c";
const DAY = 86400000;

export function initWeekly(ctx) {
  const { $, esc, STEPS } = ctx;
  const W = {
    active: false, tab: "A", start: null, docs: {}, meta: {}, unsub: [], cfg: { kl: {} },
    tool: null, draft: [], timers: {}, colored: true, pendingRender: false, msg: null,
  };

  // ---------- Ngày ----------
  const toD = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const toS = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => toS(toD(s) + n * DAY);
  const dow = (s) => new Date(toD(s)).getUTCDay();
  const dm = (s) => { if (!s) return ""; const [, m, d] = s.split("-"); return `${+d}/${+m}`; };
  const wid = (s) => "w" + s;
  const curStart = () => W.start, nxtStart = () => addDays(W.start, 7);
  const curEnd = () => addDays(W.start, 6), nxtEnd = () => addDays(W.start, 13);
  // Ngày chốt số liệu = ngày cuối tuần báo cáo (cũng là ngày trước tuần kế hoạch)
  const cutoff = () => curEnd();

  function defaultStart() {
    let wd = 6; // tuần mặc định Thứ 7 → Thứ 6 như mẫu báo cáo
    try { const v = localStorage.getItem("cftn_wkday"); if (v !== null && v !== "") wd = +v; } catch (e) {}
    const t = ctx.todayStr();
    return addDays(t, -((dow(t) - wd + 7) % 7));
  }

  const empty = (start) => ({ start, end: addDays(start, 6), zones: [], rows: [], t2: {}, res: [] });
  const docOf = (start) => W.docs[wid(start)] || (W.docs[wid(start)] = empty(start));
  const cur = () => docOf(curStart());
  const nxt = () => docOf(nxtStart());
  // Trang đang xem: A → kế hoạch tuần tới (tài liệu W+1), B → báo cáo tuần W (tài liệu W)
  const pageDoc = () => (W.tab === "A" ? nxt() : cur());

  const canEdit = () => ctx.canEdit();
  const P = () => ctx.P;

  // ---------- Đồng bộ Firestore ----------
  function stop() {
    W.unsub.forEach((u) => { try { u(); } catch (e) {} });
    W.unsub = []; W.docs = {}; W.meta = {}; W.cfg = { kl: {} };
    Object.values(W.timers).forEach(clearTimeout); W.timers = {};
  }
  function watch() {
    stop();
    if (!W.active || !P() || !ctx.be) return;
    const pid = P().id;
    const onErr = (e) => msg("Lỗi đọc kế hoạch tuần: " + (e.code === "permission-denied" ? "chưa cập nhật Firestore Rules (xem README) hoặc không có quyền." : e.code || e.message));
    [curStart(), nxtStart()].forEach((st) => {
      W.unsub.push(ctx.be.watchWeek(pid, wid(st), (d, m) => {
        if (!P() || P().id !== pid) return;
        if (m && m.hasPendingWrites) return;
        if (W.timers[wid(st)]) return; // đang có thay đổi chưa lưu → giữ bản trên máy
        W.docs[wid(st)] = Object.assign(empty(st), d || {});
        W.meta[wid(st)] = d ? { by: d.byName, at: d.at } : null;
        requestRender(); drawZones();
      }, onErr));
    });
    W.unsub.push(ctx.be.watchWeek(pid, "_cfg", (d, m) => {
      if (m && m.hasPendingWrites) return;
      if (W.timers._cfg) return;
      W.cfg = { kl: (d && d.kl) || {} }; requestRender();
    }, onErr));
  }
  function save(key) {
    if (!canEdit()) return;
    clearTimeout(W.timers[key]);
    W.timers[key] = setTimeout(async () => {
      const pid = P().id, me = ctx.me;
      const base = key === "_cfg" ? { kl: W.cfg.kl } : W.docs[key];
      const out = JSON.parse(JSON.stringify(base));
      out.by = me.uid; out.byName = me.name || ""; out.at = new Date().toISOString();
      try { await ctx.be.saveWeek(pid, key, out); delete W.timers[key]; msg("Đã lưu.", true); }
      catch (e) { delete W.timers[key]; msg("Không lưu được: " + (e.code === "permission-denied" ? "không có quyền ghi (hoặc chưa cập nhật Firestore Rules – xem README)." : e.code || e.message)); }
    }, 700);
  }
  const touch = () => save(wid(W.tab === "A" ? nxtStart() : curStart()));

  // ---------- Tính toán tiến độ ----------
  function inPoly(x, y, p) {
    let ins = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  // Cấu kiện thuộc vùng: điểm đặt số hiệu (tâm) nằm trong vùng
  // Cấu kiện thuộc vùng khi phần diện tích nằm trong vùng ≥ MIN_IN (50%).
  // Tính bằng lưới điểm mẫu phủ lên cấu kiện (đúng cả cho đà kiềng xiên, ô sàn khoét lỗ, vùng đa giác lõm).
  const MIN_IN = 0.5;
  const memo = new Map();
  function fracIn(rings, zp, zb) {
    const b = bbox(rings[0]);
    if (b.x1 < zb.x0 || b.x0 > zb.x1 || b.y1 < zb.y0 || b.y0 > zb.y1) return 0;
    const w = b.x1 - b.x0, h = b.y1 - b.y0, d = Math.sqrt((w * h) / 400) || 1;
    const nx = Math.max(4, Math.ceil(w / d)), ny = Math.max(4, Math.ceil(h / d));
    let inE = 0, inZ = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const x = b.x0 + ((i + 0.5) / nx) * w, y = b.y0 + ((j + 0.5) / ny) * h;
      let e = false; rings.forEach((r) => { if (inPoly(x, y, r)) e = !e; }); // evenodd: ô sàn có lỗ khoét
      if (!e) continue;
      inE++; if (inPoly(x, y, zp)) inZ++;
    }
    return inE ? inZ / inE : 0;
  }
  // Trả về {geo:[đà kiềng/móng], cells:[ô sàn], all:[…]}
  function members(z) {
    const key = P().id + "|" + z.p.join(",");
    if (memo.has(key)) return memo.get(key);
    const prj = P(), zb = bbox(z.p), geo = [], cells = [];
    prj.geo.forEach((g) => { if (fracIn([g.p], z.p, zb) >= MIN_IN) geo.push(g.n); });
    (prj.cells || []).forEach((c) => { if (fracIn(c.r, z.p, zb) >= MIN_IN) cells.push(c.n); });
    const out = { geo, cells, all: geo.concat(cells) };
    if (memo.size > 200) memo.clear();
    memo.set(key, out);
    return out;
  }
  const countTxt = (m) => [m.geo.length ? `${m.geo.length} ${ctx.U()}` : "", m.cells.length ? `${m.cells.length} ô` : ""].filter(Boolean).join(" · ") || "0 cấu kiện";
  // % hoàn thành của công tác s trong vùng z tại ngày asof (theo số cấu kiện)
  function zonePct(z, s, asof) {
    const prj = P(), ids = members(z).all.filter((n) => ctx.stepsFor(prj, n).includes(s));
    if (!ids.length) return null;
    const done = ids.filter((n) => ctx.doneIn(prj, ctx.data, n, s, asof)).length;
    return { done, tot: ids.length, pct: pctOf(done, ids.length) };
  }
  const pctOf = (a, b) => (b ? (a === b ? 100 : Math.floor((a / b) * 100)) : 0);
  const unitOf = (s) => (W.cfg.kl[s] && W.cfg.kl[s].u) || (ctx.isCellStep(P(), s) ? "ô" : ctx.U());
  // Bảng 2: khối lượng toàn mặt bằng tại ngày asof
  function totals(asof) {
    const { cnt, tot } = ctx.statsIn(P(), ctx.data, asof);
    return ctx.prjSteps(P()).map((s) => {
      const k = W.cfg.kl[s] || {}, v = Number(k.v) > 0 ? Number(k.v) : null;
      const kl = v ?? tot[s], pct = pctOf(cnt[s], tot[s]);
      const lk = v ? Math.round((v * cnt[s]) / (tot[s] || 1)) : cnt[s];
      return { s, name: STEPS[s].name, unit: unitOf(s), kl, lk, pct, custom: !!v, count: tot[s] };
    });
  }
  // Công tác chưa xong trong vùng (dùng để tạo dòng bảng 1)
  function openSteps(z) {
    return ctx.prjSteps(P()).filter((s) => { const r = zonePct(z, s, cutoff()); return r && r.pct < 100; });
  }

  // ---------- Vùng ----------
  const nextZoneId = (d) => d.zones.reduce((m, z) => Math.max(m, z.id), 0) + 1;
  function addZone(p) {
    if (!canEdit() || W.tab !== "A") return;
    const d = nxt(), z = { id: nextZoneId(d), n: `Tuyến ${d.zones.length + 1}`, p: p.map((v) => Math.round(v * 10) / 10) };
    if (!members(z).all.length) { msg("Vùng vừa vẽ không chứa cấu kiện nào – hãy vẽ lại."); drawZones(); return; }
    d.zones.push(z);
    const st = openSteps(z);
    st.forEach((s) => d.rows.push({ z: z.id, s, n: STEPS[s].name, b: "", e: "", kh: null, th: null }));
    touch(); render(); drawZones();
    msg(st.length ? `${z.n}: ${countTxt(members(z))}, ${st.length} công tác chưa xong.` : `${z.n}: các công tác trong vùng đã xong hết.`, true);
  }
  function addRect(a, b) {
    if (!W.active || W.tool !== "rect") return;
    if (Math.abs(a.x - b.x) < 5 || Math.abs(a.y - b.y) < 5) return;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    addZone([x0, y0, x1, y0, x1, y1, x0, y1]);
  }
  function tap(pt) {
    if (W.tool !== "poly") return;
    const tol = ctx.pxToSvg(14);
    if (W.draft.length >= 3 && Math.hypot(pt.x - W.draft[0].x, pt.y - W.draft[0].y) < tol) return closePoly();
    W.draft.push(pt); drawZones(); setTool("poly");
  }
  function closePoly() {
    if (W.draft.length < 3) { msg("Cần ít nhất 3 đỉnh."); return; }
    const p = []; W.draft.forEach((q) => p.push(q.x, q.y));
    W.draft = []; addZone(p); setTool("poly");
  }
  function setTool(t) {
    W.tool = t; if (t !== "poly") W.draft = []; if (t !== "edit") W.selZ = null;
    $("zRect").classList.toggle("on", t === "rect");
    $("zPoly").classList.toggle("on", t === "poly");
    $("zEdit").classList.toggle("on", t === "edit");
    $("zDone").hidden = !(t === "poly" && W.draft.length >= 3);
    $("zCancel").hidden = !t;
    $("zCancel").textContent = t === "edit" ? "✓ Xong" : "Huỷ vẽ";
    $("map").classList.toggle("boxmode", t === "rect" || t === "poly");
    drawZones(); ctx.updateHandle();
  }

  // Sau khi sửa hình vùng: thêm công tác chưa xong mới xuất hiện, bỏ công tác không còn cấu kiện nào trong vùng
  function syncRows(d, z) {
    const before = d.rows.length;
    d.rows = d.rows.filter((r) => r.z !== z.id || zonePct(z, r.s, cutoff()));
    const removed = before - d.rows.length;
    const have = new Set(d.rows.filter((r) => r.z === z.id).map((r) => r.s));
    const add = openSteps(z).filter((s) => !have.has(s));
    add.forEach((s) => d.rows.push({ z: z.id, s, n: STEPS[s].name, b: "", e: "", kh: null, th: null }));
    d.rows.sort((x, y) => d.zones.findIndex((q) => q.id === x.z) - d.zones.findIndex((q) => q.id === y.z) || x.s - y.s);
    return { add: add.length, removed };
  }

  // ---------- Sửa vùng: chọn vùng, kéo đỉnh, kéo chấm giữa cạnh để thêm đỉnh, Alt+bấm đỉnh để xoá, kéo trong vùng để di chuyển ----------
  function down(pt, e) {
    if (!W.active || W.tool !== "edit" || W.tab !== "A" || !canEdit()) return null;
    const d = nxt(), tol = ctx.pxToSvg(e && e.pointerType === "touch" ? 18 : 10);
    const z = d.zones.find((q) => q.id === W.selZ);
    if (z) {
      for (let i = 0; i < z.p.length; i += 2) {
        if (Math.hypot(pt.x - z.p[i], pt.y - z.p[i + 1]) < tol) {
          if (e && e.altKey) {
            if (z.p.length > 6) { const old = z.p.slice(); z.p.splice(i, 2); return { z, kind: "vdel", old }; }
            msg("Vùng cần ít nhất 3 đỉnh."); return { z, kind: "none" };
          }
          return { z, kind: "vert", i, old: z.p.slice() };
        }
      }
      const n = z.p.length / 2;
      for (let k = 0; k < n; k++) {
        const a = k * 2, b = ((k + 1) % n) * 2, mx = (z.p[a] + z.p[b]) / 2, my = (z.p[a + 1] + z.p[b + 1]) / 2;
        if (Math.hypot(pt.x - mx, pt.y - my) < tol) {
          const old = z.p.slice(); z.p.splice(a + 2, 0, mx, my);
          return { z, kind: "vert", i: a + 2, old };
        }
      }
    }
    // chọn vùng bấm trúng (vùng vẽ sau nằm trên)
    const hit = d.zones.slice().reverse().find((q) => inPoly(pt.x, pt.y, q.p));
    if (!hit) { if (W.selZ !== null) { W.selZ = null; drawZones(); } return null; }
    W.selZ = hit.id; drawZones();
    return { z: hit, kind: "move", x: pt.x, y: pt.y, old: hit.p.slice() };
  }
  function move(g, pt) {
    if (g.kind === "vert") { g.z.p[g.i] = pt.x; g.z.p[g.i + 1] = pt.y; }
    else if (g.kind === "move") { const dx = pt.x - g.x, dy = pt.y - g.y; g.z.p = g.old.map((v, k) => v + (k % 2 ? dy : dx)); }
    else return;
    drawZones(true);
  }
  function up(g, moved) {
    if (!g || g.kind === "none") return;
    if ((g.kind === "move" || g.kind === "vert") && !moved) {
      if (g.kind === "vert") g.z.p = g.old; // bấm chấm giữa cạnh mà không kéo → không thêm đỉnh
      drawZones(); return;
    }
    const d = nxt();
    g.z.p = g.z.p.map((v) => Math.round(v * 10) / 10);
    if (!members(g.z).all.length) { g.z.p = g.old; msg("Vùng sau khi sửa không còn cấu kiện nào – đã hoàn lại."); drawZones(); return; }
    const r = syncRows(d, g.z);
    touch(); render(); drawZones();
    msg(`${g.z.n}: ${countTxt(members(g.z))}` + (r.add ? ` · thêm ${r.add} công tác` : "") + (r.removed ? ` · bỏ ${r.removed} công tác không còn cấu kiện` : ""), true);
  }

  // ---------- Vẽ vùng trên SVG ----------
  const NS = "http://www.w3.org/2000/svg";
  // ---------- Màu & kiểu tô (hatch) của vùng ----------
  const ZPAL = ["#1f5aa8", "#e67e22", "#16a34a", "#8e44ad", "#c0392b", "#0e9aa7", "#b7950b", "#6b7280"];
  const ZFILLS = [["solid", "Tô đặc"], ["hatch", "Gạch chéo ╱"], ["hatch2", "Gạch chéo ╲"], ["cross", "Gạch ô chéo"],
    ["grid", "Kẻ ô vuông"], ["hline", "Kẻ ngang"], ["vline", "Kẻ dọc"], ["dot", "Chấm"], ["none", "Chỉ viền"]];
  const zIdx = (z) => pageDoc().zones.indexOf(z);
  const zColor = (z, i) => z.c || ZPAL[(i ?? Math.max(0, zIdx(z))) % ZPAL.length];
  const zFill = (z) => z.f || "solid";
  // vẽ hoa văn 1 ô lặp kích thước s (dùng chung cho SVG và canvas)
  function hatchLines(f, s) {
    const L = [];
    if (f === "hatch" || f === "cross") L.push([0, s, s, 0], [-s / 2, s / 2, s / 2, -s / 2], [s / 2, s * 1.5, s * 1.5, s / 2]);
    if (f === "hatch2" || f === "cross") L.push([0, 0, s, s], [-s / 2, s / 2, s / 2, s * 1.5], [s / 2, -s / 2, s * 1.5, s / 2]);
    if (f === "grid" || f === "hline") L.push([0, s / 2, s, s / 2]);
    if (f === "grid" || f === "vline") L.push([s / 2, 0, s / 2, s]);
    return L;
  }
  function svgPattern(defs, id, f, col, s) {
    const pt = document.createElementNS(NS, "pattern");
    pt.setAttribute("id", id); pt.setAttribute("patternUnits", "userSpaceOnUse"); pt.setAttribute("width", s); pt.setAttribute("height", s);
    hatchLines(f, s).forEach(([x1, y1, x2, y2]) => {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
      l.setAttribute("stroke", col); l.setAttribute("stroke-width", s * 0.13); l.setAttribute("stroke-opacity", ".85");
      pt.appendChild(l);
    });
    if (f === "dot") { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", s / 2); c.setAttribute("cy", s / 2); c.setAttribute("r", s * 0.16); c.setAttribute("fill", col); c.setAttribute("fill-opacity", ".85"); pt.appendChild(c); }
    defs.appendChild(pt);
  }
  // tô vùng trên canvas (xuất ảnh/PDF)
  function canvasFill(c, z, i, s) {
    const f = zFill(z), col = zColor(z, i);
    if (f === "solid") { c.globalAlpha = 0.38; c.fillStyle = col; c.fill(); c.globalAlpha = 1; return; }
    if (f === "none") return;
    c.globalAlpha = 0.1; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
    const t = document.createElement("canvas"); t.width = t.height = Math.max(6, Math.round(s));
    const tc = t.getContext("2d"), S = t.width;
    tc.strokeStyle = col; tc.fillStyle = col; tc.lineWidth = Math.max(1.5, S * 0.13); tc.globalAlpha = 0.85;
    hatchLines(f, S).forEach(([x1, y1, x2, y2]) => { tc.beginPath(); tc.moveTo(x1, y1); tc.lineTo(x2, y2); tc.stroke(); });
    if (f === "dot") { tc.beginPath(); tc.arc(S / 2, S / 2, S * 0.16, 0, Math.PI * 2); tc.fill(); }
    c.fillStyle = c.createPattern(t, "repeat"); c.fill();
  }
  // fast = đang kéo: không tính lại cấu kiện thuộc vùng cho nhẹ
  function drawZones(fast) {
    const svg = $("map"); if (!svg || !P()) return;
    let g = document.getElementById("zlayer");
    if (!g) { g = document.createElementNS(NS, "g"); g.id = "zlayer"; svg.appendChild(g); }
    else svg.appendChild(g); // luôn nằm trên cùng
    g.innerHTML = "";
    if (!fast) {
      // viền đậm các cấu kiện được tính vào vùng (≥ 50% diện tích nằm trong vùng)
      const inz = new Set();
      if (W.active) pageDoc().zones.forEach((z) => members(z).all.forEach((n) => inz.add(n)));
      svg.querySelectorAll("g.mong").forEach((m) => m.classList.toggle("inzone", inz.has(m.dataset.n)));
    }
    if (!W.active) return;
    const fs = P().width / 110, hs = P().width / 140;
    const defs = document.createElementNS(NS, "defs"); g.appendChild(defs);
    pageDoc().zones.forEach((z, i) => {
      const path = document.createElementNS(NS, "polygon");
      const pts = []; for (let k = 0; k < z.p.length; k += 2) pts.push(z.p[k] + "," + z.p[k + 1]);
      path.setAttribute("points", pts.join(" ")); path.setAttribute("class", "zone" + (z.id === W.selZ ? " zsel" : ""));
      const col = zColor(z, i), f = zFill(z);
      let fill = col, fo = z.id === W.selZ ? 0.4 : 0.3;
      if (f === "none") fo = 0;
      else if (f !== "solid") {
        // nền nhạt + hoa văn
        const bg = path.cloneNode(); bg.removeAttribute("class"); bg.setAttribute("style", `fill:${col};fill-opacity:.08;stroke:none`); g.appendChild(bg);
        svgPattern(defs, "zp" + z.id, f, col, hs); fill = `url(#zp${z.id})`; fo = 1;
      }
      path.setAttribute("style", `fill:${fill};fill-opacity:${fo};stroke:${z.id === W.selZ ? "#e60000" : col}`);
      g.appendChild(path);
      const bb = bbox(z.p), w = fs * 1.6, h = fs * 1.35, x = bb.x1 - w - fs * 0.2, y = bb.y0 + fs * 0.2;
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", h); r.setAttribute("class", "zlabel"); r.setAttribute("style", `fill:${col}`);
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", x + w / 2); t.setAttribute("y", y + h / 2); t.setAttribute("font-size", fs); t.setAttribute("class", "zlabeltxt");
      t.textContent = i + 1;
      g.append(r, t);
    });
    const sz = pageDoc().zones.find((q) => q.id === W.selZ);
    if (sz && W.tool === "edit") {
      const n = sz.p.length / 2, rv = ctx.pxToSvg(7), rm = ctx.pxToSvg(5);
      for (let k = 0; k < n; k++) {
        const a = k * 2, b = ((k + 1) % n) * 2;
        const m = document.createElementNS(NS, "circle");
        m.setAttribute("cx", (sz.p[a] + sz.p[b]) / 2); m.setAttribute("cy", (sz.p[a + 1] + sz.p[b + 1]) / 2); m.setAttribute("r", rm); m.setAttribute("class", "zmid");
        g.appendChild(m);
      }
      for (let k = 0; k < n; k++) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", sz.p[k * 2]); c.setAttribute("cy", sz.p[k * 2 + 1]); c.setAttribute("r", rv); c.setAttribute("class", "zv");
        g.appendChild(c);
      }
    }
    if (W.draft.length) {
      const pl = document.createElementNS(NS, "polyline");
      pl.setAttribute("points", W.draft.map((q) => q.x + "," + q.y).join(" "));
      pl.setAttribute("class", "zdraft"); g.appendChild(pl);
      W.draft.forEach((q, i) => {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", q.x); c.setAttribute("cy", q.y); c.setAttribute("r", ctx.pxToSvg(i === 0 ? 7 : 5));
        c.setAttribute("class", i === 0 ? "zv first" : "zv"); g.appendChild(c);
      });
    }
  }
  function bbox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    return { x0, y0, x1, y1 };
  }

  // ---------- Bật / tắt tab ----------
  function setActive(on) {
    if (on === W.active) return;
    W.active = on;
    document.querySelectorAll(".viewtabs button").forEach((b) => b.classList.toggle("on", (b.dataset.view === "week") === on));
    $("app").classList.toggle("weekly", on);
    if (on) {
      if (!W.start) W.start = defaultStart();
      ctx.clearSel();
      W.savedAsof = $("asof").value;
      watch();
    } else {
      setTool(null); stop();
      if (W.savedAsof) $("asof").value = W.savedAsof;
    }
    applyAsof(); render(); drawZones(); ctx.updateHandle();
  }
  // Mặt bằng tô màu tiến độ tại ngày chốt số liệu (cuối tuần báo cáo)
  function applyAsof() {
    if (!W.active) { $("map").classList.remove("nocolor"); ctx.paint(); return; }
    $("asof").value = cutoff();
    $("map").classList.toggle("nocolor", !W.colored);
    ctx.paint();
  }
  function setStart(s) {
    if (!s) return;
    W.start = s;
    try { localStorage.setItem("cftn_wkday", String(dow(s))); } catch (e) {}
    setTool(null); watch(); applyAsof(); render(); drawZones();
  }

  // ---------- Bảng bên phải ----------
  function msg(text, ok) {
    W.msg = { text, ok, t: Date.now() };
    const m = document.getElementById("wkMsg");
    if (m) { m.textContent = text; m.style.color = ok ? "#05603a" : "#b42318"; }
  }
  function requestRender() {
    const a = document.activeElement;
    if (a && a.closest && a.closest("#wksec") && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { W.pendingRender = true; return; }
    render();
  }
  const defTitle = (tab) => {
    const [house, kind] = ctx.splitName(ctx.projName());
    const tail = `${kind} ${house}`.toLocaleUpperCase("vi");
    return tab === "A" ? `B. TIẾN ĐỘ ${tail}` : `B. THỰC HIỆN TRONG TUẦN ${tail}`;
  };
  const titleOf = (tab) => (tab === "A" ? nxt().tA : cur().tB) || defTitle(tab);
  const dateOf = (tab) => (tab === "A" ? nxt().dA || curEnd() : cur().dB || addDays(curEnd(), 1));
  const fmtNum = (v) => (v === null || v === undefined || v === "" ? "" : Number(v).toLocaleString("vi-VN"));
  const pctTxt = (v) => (v === null || v === undefined || v === "" ? "" : `${v}%`);
  const zoneName = (d, id) => { const i = d.zones.findIndex((z) => z.id === id); return i < 0 ? null : d.zones[i]; };

  function render() {
    W.pendingRender = false;
    const box = $("wksec"); if (!box) return;
    if (!W.active || !P()) { box.innerHTML = ""; return; }
    $("wkStart").value = W.start;
    $("wkRange").textContent = `${dm(curStart())} – ${dm(curEnd())}/${curEnd().slice(0, 4)}`;
    const ed = canEdit(), A = W.tab === "A", d = pageDoc(), dis = ed ? "" : " disabled";
    document.querySelectorAll(".wked").forEach((b) => (b.hidden = !(ed && A)));
    if (!(ed && A) && W.tool) setTool(null);
    const asof = cutoff(), T = totals(asof);
    let h = `<div class="wktabs">
      <button data-tab="A" class="${A ? "on" : ""}">A. Kế hoạch tuần tới<small>${dm(nxtStart())} – ${dm(nxtEnd())}</small></button>
      <button data-tab="B" class="${A ? "" : "on"}">B. Báo cáo tuần<small>${dm(curStart())} – ${dm(curEnd())}</small></button>
    </div>`;
    h += ed ? "" : `<div class="note">Bạn có quyền chỉ xem.</div>`;
    const meta = W.meta[wid(A ? nxtStart() : curStart())];
    h += `<div class="wkform">
      <label>Tiêu đề trang <input type="text" id="wkTitle" value="${esc(titleOf(W.tab))}"${dis}></label>
      <label>Ngày lập <input type="date" id="wkDate" value="${dateOf(W.tab)}"${dis}></label>
    </div>
    <div class="muted small">Số liệu tính đến hết ngày <b>${ctx.fmt(asof)}</b>${meta && meta.at ? ` · Lưu lần cuối: ${esc(meta.by || "")}, ${new Date(meta.at).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}` : ""}</div>`;

    // ----- Bảng 1 -----
    h += `<h3>Bảng 1 – Công tác theo vùng ${A ? "<small>(kế hoạch tuần tới)</small>" : "<small>(kế hoạch đã lập cho tuần này)</small>"}</h3>`;
    if (!d.zones.length) {
      h += `<div class="empty">${A
        ? (ed ? `Chưa có vùng nào. Bấm <b>▭ Vẽ vùng</b> rồi kéo khung trên mặt bằng, hoặc <b>⬠ Vẽ đa giác</b> rồi bấm lần lượt các đỉnh (bấm lại đỉnh đầu để đóng). Mỗi vùng là một tuyến; bảng sẽ liệt kê các công tác chưa xong trong vùng.` : "Chưa có kế hoạch cho tuần tới.")
        : `Chưa có kế hoạch cho tuần ${dm(curStart())} – ${dm(curEnd())}. Kế hoạch được lập ở tab <b>A</b> khi chọn tuần báo cáo trước đó (◀).`}</div>`;
    } else {
      if (!A && ed) h += `<div class="actions" style="margin:0 0 6px"><button id="fillActual" title="Điền % thực hiện bằng % hoàn thành thực tế trong vùng tính đến ${ctx.fmt(asof)} (chỉ các ô còn trống)">Điền % theo thực tế</button></div>`;
      h += `<div class="tblwrap"><table class="wk t1"><thead><tr><th>Công tác</th><th>Bắt đầu</th><th>Kết thúc</th><th>% hoàn thành kế hoạch</th><th>% thực hiện trong tuần</th>${A && ed ? "<th></th>" : ""}</tr></thead><tbody>`;
      d.zones.forEach((z, zi) => {
        const n = countTxt(members(z));
        h += `<tr class="grp"><td colspan="${A && ed ? 6 : 5}"><span class="zno" style="background:${zColor(z, zi)}">${zi + 1}</span>` +
          (A && ed ? `<input type="text" class="zn" data-z="${z.id}" value="${esc(z.n)}"> <small class="muted">${n}</small>
            <button class="link" data-zref="${z.id}" title="Thêm lại các công tác chưa xong của vùng">↻ công tác</button>
            <button class="x" data-zdel="${z.id}" title="Xoá vùng và các công tác của vùng">×</button>`
            : `<b>${esc(z.n)}</b> <small class="muted">${n}</small>`) +
          (A && ed ? `<span class="zsty"><input type="color" class="zc" data-z="${z.id}" value="${zColor(z, zi)}" title="Màu vùng">` +
            `<select class="zf" data-z="${z.id}" title="Kiểu tô vùng">${ZFILLS.map(([v, t]) => `<option value="${v}"${v === zFill(z) ? " selected" : ""}>${t}</option>`).join("")}</select></span>` : "") +
          `</td></tr>`;
        d.rows.forEach((r, ri) => {
          if (r.z !== z.id) return;
          const now = zonePct(z, r.s, asof), np = now ? now.pct : 0;
          if (A) {
            h += `<tr data-r="${ri}" class="ra${ed ? "" : " ro"}">
              <td class="cn">${ed ? `<input type="text" class="rn" value="${esc(r.n)}">` : esc(r.n)}</td>
              <td data-l="Bắt đầu"><input type="date" class="rb" value="${r.b || ""}"${dis}></td>
              <td data-l="Kết thúc"><input type="date" class="re" value="${r.e || ""}"${dis}></td>
              <td data-l="% kế hoạch"><input type="number" inputmode="numeric" class="rk pct" value="${r.kh ?? ""}" min="${np + 1}" max="100" step="1"${dis}><small class="muted"> hiện ${np}%</small></td>
              <td class="muted dash">—</td>
              ${ed ? `<td class="del"><button class="x" data-rdel="${ri}" title="Bỏ công tác khỏi kế hoạch">×</button></td>` : ""}</tr>`;
          } else {
            h += `<tr data-r="${ri}" class="rbk"><td class="cn">${esc(r.n)}</td>` +
              (ed ? `<td data-l="Bắt đầu"><input type="date" class="rb" value="${r.b || ""}"></td><td data-l="Kết thúc"><input type="date" class="re" value="${r.e || ""}"></td>` : `<td data-l="Bắt đầu">${dm(r.b)}</td><td data-l="Kết thúc">${dm(r.e)}</td>`) +
              `<td data-l="% KH">${pctTxt(r.kh)}</td>
              <td data-l="% thực hiện"><input type="number" inputmode="numeric" class="rt pct" value="${r.th ?? ""}" min="0" max="100" step="1"${dis}><small class="muted"> thực tế ${np}%</small></td></tr>`;
          }
        });
      });
      h += `</tbody></table></div>`;
    }

    // ----- Bảng 2 -----
    const t2 = nxt().t2 || {};
    const prevT2 = A ? (cur().t2 || {}) : {};
    h += `<h3>Bảng 2 – Khối lượng toàn mặt bằng</h3>
      <div class="tblwrap"><table class="wk t2"><thead><tr><th>Công tác hạng mục</th><th>KL tổng<small>(bấm để sửa)</small></th>
      <th>KL lũy kế ${A ? "tuần trước" : "tuần này"}</th><th>% thi công lũy kế ${A ? "tuần trước" : "tuần này"}</th><th>% kế hoạch ${A ? "tuần này" : "tuần tới"}</th></tr></thead><tbody>`;
    T.forEach((r) => {
      h += `<tr data-s="${r.s}"><td>${esc(r.name)} <small class="muted">(${esc(r.unit)})</small></td>
        <td class="kl"><input type="number" class="klv" value="${r.custom ? r.kl : ""}" placeholder="${r.count}" min="0" step="any"${dis}><input type="text" class="klu" value="${esc(W.cfg.kl[r.s] && W.cfg.kl[r.s].u || "")}" placeholder="${esc(r.unit)}"${dis}></td>
        <td class="num">${fmtNum(r.lk)}</td><td class="num">${r.pct}%</td>
        <td><input type="number" class="t2k pct" value="${t2[r.s] ?? ""}" min="${Math.min(100, r.pct + 1)}" max="100" step="1"${dis}${r.pct >= 100 ? ' placeholder="xong"' : ""}></td></tr>`;
    });
    h += `</tbody></table></div>`;
    h += `<div class="muted small">KL tổng để trống = số ${ctx.U()}/ô trên mặt bằng; nhập khối lượng thật (vd 32200 kg) thì KL lũy kế = KL tổng × % hoàn thành theo số cấu kiện. ${A ? "" : "% kế hoạch tuần tới cũng chính là % kế hoạch tuần này ở tab A của tuần sau."}</div>`;
    if (A && Object.keys(prevT2).length) {
      h += `<div class="muted small">Kế hoạch tuần này đã đặt: ${ctx.prjSteps(P()).filter((s) => prevT2[s] != null).map((s) => `${STEPS[s].name} ${prevT2[s]}%`).join(" · ")}</div>`;
    }

    // ----- Nhân lực – thiết bị -----
    h += `<h3>Nhân lực – thiết bị <small>(tuỳ chọn, hiện trong trang xuất)</small></h3>
      <div class="tblwrap"><table class="wk t3"><thead><tr><th>Nội dung CBKT / thiết bị</th><th>Số lượng</th><th>Ghi chú</th>${ed ? "<th></th>" : ""}</tr></thead><tbody>`;
    (d.res || []).forEach((r, i) => {
      h += `<tr data-i="${i}"><td><input type="text" class="qn" value="${esc(r.n)}"${dis}></td><td><input type="text" class="qq" value="${esc(r.q)}"${dis}></td><td><input type="text" class="qg" value="${esc(r.g)}"${dis}></td>${ed ? `<td><button class="x" data-qdel="${i}">×</button></td>` : ""}</tr>`;
    });
    h += `</tbody></table></div>`;
    if (ed) h += `<div class="actions"><button id="qAdd">+ Thêm dòng</button>${!(d.res || []).length && (A ? cur() : docOf(addDays(curStart(), -7))).res?.length ? `<button id="qCopy">Lấy theo tuần trước</button>` : ""}</div>`;
    h += `<div class="msg" id="wkMsg"></div>`;
    box.innerHTML = h;
    if (W.msg && Date.now() - W.msg.t < 5000) msg(W.msg.text, W.msg.ok);
    bindPanel(box);
  }

  function bad(inp, text) { inp.classList.add("bad"); msg(text); }
  function good(inp) { inp.classList.remove("bad"); }

  function bindPanel(box) {
    box.querySelectorAll(".wktabs [data-tab]").forEach((b) => (b.onclick = () => { W.tab = b.dataset.tab; setTool(null); render(); drawZones(); ctx.updateHandle(); }));
    if (!canEdit()) return;
    const A = W.tab === "A", d = pageDoc();
    $("wkTitle").onchange = (e) => { const v = e.target.value.trim(); if (A) d.tA = v; else d.tB = v; touch(); };
    $("wkDate").onchange = (e) => { if (A) d.dA = e.target.value; else d.dB = e.target.value; touch(); };

    // Bảng 1
    box.querySelectorAll(".zn").forEach((i) => (i.onchange = () => { const z = zoneName(d, +i.dataset.z); if (z) { z.n = i.value.trim() || z.n; touch(); } }));
    box.querySelectorAll(".zc").forEach((i) => (i.oninput = i.onchange = () => {
      const z = zoneName(d, +i.dataset.z); if (!z) return;
      z.c = i.value; touch(); drawZones();
      const b = i.closest("tr").querySelector(".zno"); if (b) b.style.background = i.value;
    }));
    box.querySelectorAll(".zf").forEach((i) => (i.onchange = () => { const z = zoneName(d, +i.dataset.z); if (z) { z.f = i.value; touch(); drawZones(); } }));
    box.querySelectorAll("[data-zdel]").forEach((b) => (b.onclick = () => {
      if (b.dataset.ok !== "1") { b.dataset.ok = "1"; b.textContent = "Xoá vùng?"; b.style.color = "#d92d20"; b.style.fontSize = "12px"; return; }
      const id = +b.dataset.zdel; d.zones = d.zones.filter((z) => z.id !== id); d.rows = d.rows.filter((r) => r.z !== id);
      touch(); render(); drawZones();
    }));
    box.querySelectorAll("[data-zref]").forEach((b) => (b.onclick = () => {
      const z = zoneName(d, +b.dataset.zref); if (!z) return;
      const have = new Set(d.rows.filter((r) => r.z === z.id).map((r) => r.s));
      const add = openSteps(z).filter((s) => !have.has(s));
      // chèn sau dòng cuối của vùng, giữ thứ tự công tác
      add.forEach((s) => d.rows.push({ z: z.id, s, n: STEPS[s].name, b: "", e: "", kh: null, th: null }));
      d.rows.sort((x, y) => d.zones.findIndex((q) => q.id === x.z) - d.zones.findIndex((q) => q.id === y.z) || x.s - y.s);
      if (add.length) touch();
      msg(add.length ? `Đã thêm ${add.length} công tác.` : "Không còn công tác chưa xong nào để thêm.", true); render();
    }));
    box.querySelectorAll("[data-rdel]").forEach((b) => (b.onclick = () => { d.rows.splice(+b.dataset.rdel, 1); touch(); render(); }));
    box.querySelectorAll(".t1 tr[data-r]").forEach((tr) => {
      const r = d.rows[+tr.dataset.r], q = (c) => tr.querySelector(c);
      const z = zoneName(d, r.z);
      if (q(".rn")) q(".rn").onchange = (e) => { r.n = e.target.value.trim() || STEPS[r.s].name; touch(); };
      // Ngày bắt đầu / kết thúc: được trùng nhau (công tác 1 ngày), không giới hạn trong tuần (công tác có thể kéo dài).
      // Nếu nhập sai thứ tự thì báo và trả ô về giá trị đã lưu, tránh hiện ngày mà không được lưu.
      const setDate = (key, inp) => {
        const v = inp.value || "", b = key === "b" ? v : r.b, e2 = key === "e" ? v : r.e;
        if (b && e2 && e2 < b) { inp.value = r[key] || ""; return bad(inp, "Ngày kết thúc không được trước ngày bắt đầu."); }
        good(q(".rb")); good(q(".re")); r[key] = v; touch();
      };
      if (q(".rb")) { q(".rb").onchange = (e) => setDate("b", e.target); q(".rb").onblur = (e) => { if ((e.target.value || "") !== (r.b || "")) setDate("b", e.target); }; }
      if (q(".re")) { q(".re").onchange = (e) => setDate("e", e.target); q(".re").onblur = (e) => { if ((e.target.value || "") !== (r.e || "")) setDate("e", e.target); }; }
      if (q(".rk")) q(".rk").onchange = (e) => {
        const raw = e.target.value;
        if (raw === "") { good(e.target); r.kh = null; touch(); return; }
        const v = Number(raw), now = z ? (zonePct(z, r.s, cutoff()) || { pct: 0 }).pct : 0;
        if (!Number.isFinite(v) || v <= now || v > 100) return bad(e.target, `% hoàn thành kế hoạch phải lớn hơn ${now}% (hiện tại) và không quá 100%.`);
        good(e.target); r.kh = Math.round(v * 10) / 10; touch();
      };
      if (q(".rt")) q(".rt").onchange = (e) => {
        const raw = e.target.value;
        if (raw === "") { good(e.target); r.th = null; touch(); return; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > 100) return bad(e.target, "% thực hiện phải từ 0 đến 100.");
        good(e.target); r.th = Math.round(v * 10) / 10; touch();
      };
    });
    const fa = $("fillActual");
    if (fa) fa.onclick = () => {
      let n = 0;
      d.rows.forEach((r) => { if (r.th != null) return; const z = zoneName(d, r.z); if (!z) return; const p = zonePct(z, r.s, cutoff()); r.th = p ? p.pct : 0; n++; });
      if (n) touch(); msg(n ? `Đã điền ${n} dòng theo thực tế.` : "Các dòng đã có % thực hiện.", true); render();
    };

    // Bảng 2
    box.querySelectorAll(".t2 tr[data-s]").forEach((tr) => {
      const s = tr.dataset.s, q = (c) => tr.querySelector(c);
      const setKl = () => {
        const v = q(".klv").value, u = q(".klu").value.trim();
        if (v !== "" && !(Number(v) >= 0)) return bad(q(".klv"), "Khối lượng không hợp lệ.");
        good(q(".klv"));
        if (v === "" && !u) delete W.cfg.kl[s]; else W.cfg.kl[s] = { v: v === "" ? null : Number(v), u };
        save("_cfg");
        // cập nhật tại chỗ dòng này (không vẽ lại cả bảng để khỏi mất ô đang nhập)
        const t = totals(cutoff()).find((x) => String(x.s) === s);
        tr.querySelector("td small").textContent = `(${t.unit})`;
        tr.querySelector("td.num").textContent = fmtNum(t.lk);
        q(".klu").placeholder = t.unit;
      };
      q(".klv").onchange = setKl; q(".klu").onchange = setKl;
      q(".t2k").onchange = (e) => {
        const raw = e.target.value, N = nxt(); N.t2 = N.t2 || {};
        if (raw === "") { good(e.target); delete N.t2[s]; save(wid(nxtStart())); return; }
        const v = Number(raw), lk = totals(cutoff()).find((t) => String(t.s) === s).pct;
        if (!Number.isFinite(v) || v <= lk || v > 100) return bad(e.target, `% kế hoạch phải lớn hơn ${lk}% (lũy kế) và không quá 100%.`);
        good(e.target); N.t2[s] = Math.round(v * 10) / 10; save(wid(nxtStart()));
      };
    });

    // Nhân lực – thiết bị
    d.res = d.res || [];
    box.querySelectorAll(".t3 tr[data-i]").forEach((tr) => {
      const r = d.res[+tr.dataset.i];
      [["qn", "n"], ["qq", "q"], ["qg", "g"]].forEach(([c, k]) => (tr.querySelector("." + c).onchange = (e) => { r[k] = e.target.value; touch(); }));
    });
    box.querySelectorAll("[data-qdel]").forEach((b) => (b.onclick = () => { d.res.splice(+b.dataset.qdel, 1); touch(); render(); }));
    if ($("qAdd")) $("qAdd").onclick = () => { d.res.push({ n: "", q: "", g: "" }); render(); const l = box.querySelectorAll(".t3 .qn"); if (l.length) l[l.length - 1].focus(); };
    if ($("qCopy")) $("qCopy").onclick = () => { const src = (A ? cur() : docOf(addDays(curStart(), -7))).res || []; d.res = src.map((r) => ({ ...r })); touch(); render(); };
  }

  // ---------- Xuất trang báo cáo ----------
  function wrap(c, text, maxW) {
    const words = String(text ?? "").split(/\s+/).filter(Boolean), lines = []; let line = "";
    words.forEach((w) => { const t = line ? line + " " + w : w; if (c.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  const FONT = "Cambria, 'Times New Roman', Georgia, serif";
  // cols: [{w, h(tiêu đề)}]; rows: [{group}] | [{cells}] ; trả về chiều cao
  function drawTable(c, x, y, cols, rows, fs, draw) {
    const pad = fs * 0.4, lh = fs * 1.2, gap = 3;
    c.font = `bold ${fs}px ${FONT}`;
    const hl = cols.map((k) => wrap(c, k.h, k.w - 2 * pad)), hh = Math.max(...hl.map((l) => l.length)) * lh + 2 * pad;
    let yy = y;
    if (draw) {
      let xx = x;
      cols.forEach((k, i) => {
        c.fillStyle = BLUE; c.fillRect(xx, yy, k.w - gap, hh - gap);
        c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
        hl[i].forEach((t, j) => c.fillText(t, xx + k.w / 2, yy + pad + lh * (j + 0.5) + (hh - 2 * pad - hl[i].length * lh) / 2));
        xx += k.w;
      });
    }
    yy += hh;
    const tw = cols.reduce((a, k) => a + k.w, 0);
    rows.forEach((r, ri) => {
      if (r.group !== undefined) {
        const rh = lh + 2 * pad;
        if (draw) {
          c.fillStyle = "#cfd5e3"; c.fillRect(x, yy, tw - gap, rh - gap);
          c.font = `bold ${fs}px ${FONT}`; c.fillStyle = "#111"; c.textAlign = "center"; c.textBaseline = "middle";
          c.fillText(r.group, x + tw / 2, yy + rh / 2);
        }
        yy += rh; return;
      }
      c.font = `${fs}px ${FONT}`;
      const cl = r.cells.map((t, i) => wrap(c, t, cols[i].w - 2 * pad));
      const rh = Math.max(...cl.map((l) => l.length)) * lh + 2 * pad;
      if (draw) {
        let xx = x;
        cols.forEach((k, i) => {
          c.fillStyle = ri % 2 ? "#e6e9f1" : "#d7dbe6"; c.fillRect(xx, yy, k.w - gap, rh - gap);
          c.fillStyle = "#222"; c.textAlign = "left"; c.textBaseline = "middle";
          cl[i].forEach((t, j) => c.fillText(t, xx + pad, yy + pad + lh * (j + 0.5)));
          xx += k.w;
        });
      }
      yy += rh;
    });
    return yy - y;
  }
  function tableData(tab) {
    const A = tab === "A", d = A ? nxt() : cur(), asof = cutoff(), T = totals(asof), t2 = nxt().t2 || {};
    const rows1 = [];
    d.zones.forEach((z) => {
      const rs = d.rows.filter((r) => r.z === z.id);
      rows1.push({ group: z.n });
      rs.forEach((r) => rows1.push({ cells: [r.n, dm(r.b), dm(r.e), pctTxt(r.kh), A ? "" : pctTxt(r.th)] }));
    });
    const rows2 = T.map((r) => ({ cells: [`${r.name} (${r.unit})`, fmtNum(r.kl), fmtNum(r.lk), `${r.pct}%`, pctTxt(t2[r.s])] }));
    const rows3 = (d.res || []).filter((r) => r.n || r.q).map((r) => ({ cells: [r.n, r.q, r.g] }));
    return { d, rows1, rows2, rows3 };
  }
  // Độ rộng cột tự co theo nội dung: cột không xuống dòng, tiêu đề được xuống tối đa 3 dòng
  function autoCols(c, heads, rows, fs) {
    const pad = fs * 0.4;
    c.font = `${fs}px ${FONT}`;
    const body = heads.map((_, i) => Math.max(0, ...rows.filter((r) => r.cells).map((r) => c.measureText(String(r.cells[i] ?? "")).width)));
    const grp = Math.max(0, ...rows.filter((r) => r.group !== undefined).map((r) => c.measureText(r.group).width));
    c.font = `bold ${fs}px ${FONT}`;
    const cols = heads.map((h, i) => {
      const word = Math.max(...h.split(/\s+/).map((w) => c.measureText(w).width)), full = c.measureText(h).width;
      return { h, w: Math.ceil(Math.max(body[i], word, full / 3) + 2 * pad + 4) };
    });
    const tw = cols.reduce((a, k) => a + k.w, 0);
    if (grp + 2 * pad > tw) cols[0].w += grp + 2 * pad - tw;
    return cols;
  }
  const colsW = (cols) => cols.reduce((a, k) => a + k.w, 0);
  // Giãn các cột theo tỉ lệ để bảng rộng đúng W (các bảng xếp chồng cùng một chiều rộng)
  const stretch = (cols, W) => { const t = colsW(cols); return t >= W ? cols : cols.map((k) => ({ ...k, w: (k.w * W) / t })); };

  // Trang báo cáo: Wd × H (PNG 16:9, PDF khổ A3 ngang). Mặt bằng được ưu tiên to nhất có thể.
  async function renderPage(tab, Wd, H) {
    const A = tab === "A", prj = P(), { d, rows1, rows2, rows3 } = tableData(tab);
    const cv = document.createElement("canvas"); cv.width = Wd; cv.height = H;
    const c = cv.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, Wd, H);
    const M = Math.round(Wd * 0.012), u = Wd / 3840; // lề, đơn vị co theo khổ
    // Chân trang
    const footH = Math.round(44 * u), footY = H - M - footH;
    c.fillStyle = "#0a6cbf"; c.fillRect(M, footY, Wd - 2 * M, footH);
    // Logo + tiêu đề trên cùng một dải
    const headH = Math.round(190 * u);
    let logoW = 0;
    try {
      const lg = new Image(); lg.src = "img/logo-daidung.png"; await lg.decode();
      const lh = headH - 20 * u; logoW = (lg.width / lg.height) * lh; c.drawImage(lg, M + 20 * u, M, logoW, lh);
    } catch (e) {}
    const title = titleOf(tab), [house, kind] = ctx.splitName(ctx.projName());
    const tail = `${kind} ${house}`.toLocaleUpperCase("vi");
    const k = title.toLocaleUpperCase("vi").lastIndexOf(tail);
    const t1 = k > 0 ? title.slice(0, k) : title, t2 = k > 0 ? title.slice(k) : "";
    const tx0 = M + logoW + 60 * u, tmax = Wd - tx0 - M;
    let tf = Math.round(88 * u); c.font = `bold ${tf}px ${FONT}`;
    while (c.measureText(title).width > tmax && tf > 30) { tf -= 2; c.font = `bold ${tf}px ${FONT}`; }
    const tw = c.measureText(title).width, tx = Math.max(tx0, (Wd - tw) / 2);
    c.textAlign = "left"; c.textBaseline = "middle";
    const ty = M + headH * 0.4;
    c.fillStyle = BLUE; c.fillText(t1, tx, ty);
    c.fillStyle = "#e60000"; c.fillText(t2, tx + c.measureText(t1).width, ty);
    // Dòng thời gian dưới tiêu đề: tuần kế hoạch (A) hoặc tuần báo cáo (B)
    const ws = A ? nxtStart() : curStart(), we = A ? nxtEnd() : curEnd();
    const sub = `Từ ngày ${ctx.fmt(ws)} đến ngày ${ctx.fmt(we)}`;
    c.font = `italic bold ${Math.round(tf * 0.55)}px ${FONT}`; c.fillStyle = BLUE; c.textAlign = "center";
    c.fillText(sub, tx + tw / 2, M + headH * 0.86); c.textAlign = "left";

    // ----- Bố trí: thử các cỡ chữ và 2 cách đặt bảng 2, chọn cách cho mặt bằng to nhất -----
    const y0 = M + headH + 10 * u, bottom = footY - 16 * u, availH = bottom - y0, gap = Math.round(28 * u), gut = Math.round(40 * u);
    const h1 = ["Công tác", "Bắt đầu", "Kết thúc", "% hoàn thành kế hoạch", "% thực hiện trong tuần"];
    const h2 = ["Công tác", "KL tổng", A ? "KLT lũy kế tuần trước" : "KLT lũy kế tuần này", A ? "% thi công lũy kế tuần trước" : "% thi công lũy kế tuần này", A ? "% kế hoạch tuần này" : "% kế hoạch tuần tới"];
    const h3 = ["Nội dung CBKT/ thiết bị", "Số lượng", "Ghi chú"];
    const rows1x = rows1.length ? rows1 : [{ cells: ["(chưa khoanh vùng)", "", "", "", ""] }];
    const signNames = ["Kỹ thuật hiện trường", "Chỉ Huy Trưởng"];
    const SIGN_SPACE = Math.round(300 * u);
    // Ghi chú màu công tác dưới mặt bằng (khi bật Tô màu tiến độ)
    const legItems = W.colored ? [{ name: "Chưa thi công", color: "#ffffff" }].concat(ctx.prjSteps(prj).map((i) => ctx.STEPS[i])) : [];
    function legLayout(fs, width) {
      if (!legItems.length) return { h: 0, rows: [] };
      c.font = `${fs}px ${FONT}`;
      const sw = fs * 1.6, ig = fs * 1.6, rows = [[]]; let x = 0;
      legItems.forEach((it) => {
        const w = sw + fs * 0.5 + c.measureText(it.name).width;
        if (x && x + w > width) { rows.push([]); x = 0; }
        rows[rows.length - 1].push({ ...it, w }); x += w + ig;
      });
      return { h: rows.length * fs * 1.7, rows, sw, ig };
    }
    const cands = [];
    for (let fs = Math.round(44 * u); fs >= Math.round(22 * u); fs -= 2) {
      const c1 = autoCols(c, h1, rows1x, fs), c2 = autoCols(c, h2, rows2, fs), c3 = rows3.length ? autoCols(c, h3, rows3, fs) : null;
      const th1 = drawTable(c, 0, 0, c1, rows1x, fs, false), th2 = drawTable(c, 0, 0, c2, rows2, fs, false), th3 = c3 ? drawTable(c, 0, 0, c3, rows3, fs, false) : 0;
      c.font = `bold ${Math.max(fs * 1.2, 40 * u)}px ${FONT}`;
      const signW = signNames.reduce((a, t) => a + c.measureText(t).width, 0) + fs * 3;
      const signH = fs * 1.2 * 1.3 + SIGN_SPACE + fs * 1.5; // tên + chỗ ký + ngày
      for (const t2Left of [true, false]) {
        const leftW = Math.max(colsW(c1), c3 ? colsW(c3) : 0, signW, t2Left ? colsW(c2) : 0);
        const leftH = th1 + (c3 ? gap + th3 : 0) + (t2Left ? gap + th2 : 0) + gap + signH;
        if (leftH > availH) continue;
        const mapX = M + leftW + gut, mapAW = Wd - M - mapX, lg = legLayout(fs, mapAW), mapAH = availH - (t2Left ? 0 : th2 + gap) - (lg.h ? lg.h + gap : 0);
        if (!t2Left && colsW(c2) > mapAW) continue;
        const sc = Math.min(mapAW / prj.width, mapAH / prj.height);
        cands.push({ fs, c1, c2, c3, th1, th2, th3, t2Left, leftW, mapX, mapAW, mapAH, sc, signH, lg });
      }
    }
    // Chọn cỡ chữ lớn nhất mà mặt bằng vẫn đạt ≥ 90% kích thước lớn nhất có thể; cùng cỡ chữ thì lấy cách cho mặt bằng to hơn
    let best = null;
    if (cands.length) {
      const maxSc = Math.max(...cands.map((x) => x.sc));
      cands.filter((x) => x.sc >= maxSc * 0.9).forEach((x) => {
        if (!best || x.fs > best.fs || (x.fs === best.fs && x.sc > best.sc * 1.001)) best = x;
      });
    }
    if (!best) { // quá nhiều dòng: dùng cỡ chữ nhỏ nhất, bảng 2 bên trái
      const fs = Math.round(20 * u), c1 = autoCols(c, h1, rows1x, fs), c2 = autoCols(c, h2, rows2, fs), c3 = rows3.length ? autoCols(c, h3, rows3, fs) : null;
      const leftW = Math.max(colsW(c1), colsW(c2), c3 ? colsW(c3) : 0), mapX = M + leftW + gut, mapAW = Wd - M - mapX;
      const lg = legLayout(fs, mapAW);
      best = { lg, fs, c1, c2, c3, th1: drawTable(c, 0, 0, c1, rows1x, fs, false), th2: drawTable(c, 0, 0, c2, rows2, fs, false), th3: c3 ? drawTable(c, 0, 0, c3, rows3, fs, false) : 0,
        t2Left: true, leftW, mapX, mapAW, mapAH: availH - (lg.h ? lg.h + gap : 0), signH: fs * 6 };
      best.sc = Math.min(mapAW / prj.width, best.mapAH / prj.height);
    }
    const B = best, fs = B.fs;
    // các bảng xếp dọc ở cột trái có cùng chiều rộng
    B.c1 = stretch(B.c1, B.leftW); if (B.c3) B.c3 = stretch(B.c3, B.leftW); if (B.t2Left) B.c2 = stretch(B.c2, B.leftW);

    // ----- Mặt bằng -----
    const mw = prj.width * B.sc, mh = prj.height * B.sc;
    const mx = B.mapX + (B.mapAW - mw) / 2, my = y0 + (B.mapAH - mh) / 2;
    await ctx.drawPlanOn(c, prj, ctx.data, cutoff(), mx, my, B.sc, W.colored);
    if (B.lg.h) {
      const L = B.lg; let ly = my + mh + gap;
      c.font = `${fs}px ${FONT}`; c.textAlign = "left"; c.textBaseline = "middle";
      L.rows.forEach((row) => {
        const rw = row.reduce((a, it) => a + it.w, 0) + L.ig * (row.length - 1);
        let lx = B.mapX + (B.mapAW - rw) / 2; const cy = ly + fs * 0.85;
        row.forEach((it) => {
          c.globalAlpha = 0.85; c.fillStyle = it.color; c.fillRect(lx, cy - fs * 0.5, L.sw, fs);
          c.globalAlpha = 1; c.strokeStyle = "#555"; c.lineWidth = Math.max(1, 2 * u); c.strokeRect(lx, cy - fs * 0.5, L.sw, fs);
          c.fillStyle = "#111"; c.fillText(it.name, lx + L.sw + fs * 0.5, cy);
          lx += it.w + L.ig;
        });
        ly += fs * 1.7;
      });
    }
    const fsz = Math.max(26 * u, Math.min(52 * u, mw / 60));
    d.zones.forEach((z, i) => {
      c.beginPath(); c.moveTo(mx + z.p[0] * B.sc, my + z.p[1] * B.sc);
      for (let j = 2; j < z.p.length; j += 2) c.lineTo(mx + z.p[j] * B.sc, my + z.p[j + 1] * B.sc);
      c.closePath();
      canvasFill(c, z, i, Math.max(14 * u, (prj.width / 140) * B.sc));
      c.globalAlpha = 0.95; c.strokeStyle = zColor(z, i); c.lineWidth = 6 * u; c.stroke(); c.globalAlpha = 1;
    });
    d.zones.forEach((z, i) => {
      const bb = bbox(z.p), bw = fsz * 1.25, bh = fsz * 1.2;
      const bx = mx + bb.x1 * B.sc - bw - 4 * u, by = my + bb.y0 * B.sc + 4 * u;
      c.fillStyle = zColor(z, i); c.fillRect(bx, by, bw, bh);
      c.strokeStyle = "#e60000"; c.lineWidth = 3 * u; c.strokeRect(bx + 1.5 * u, by + 1.5 * u, bw - 3 * u, bh - 3 * u);
      c.fillStyle = "#fff"; c.font = `${fsz}px ${FONT}`; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(String(i + 1), bx + bw / 2, by + bh / 2 + fsz * 0.05);
    });

    // ----- Bảng -----
    const lx = M;
    let ly = y0 + drawTable(c, lx, y0, B.c1, rows1x, fs, true);
    if (B.c3) ly += gap + drawTable(c, lx, ly + gap, B.c3, rows3, fs, true);
    if (B.t2Left) ly += gap + drawTable(c, lx, ly + gap, B.c2, rows2, fs, true);
    else drawTable(c, B.mapX + (B.mapAW - colsW(B.c2)) / 2, bottom - B.th2, B.c2, rows2, fs, true);

    // ----- Chữ ký + ngày (cuối cột trái) -----
    const dateY = bottom - fs * 0.6;
    // tên người ký ngay dưới bảng, phía dưới chừa trống ít nhất SIGN_SPACE để ký
    const sy = Math.min(ly + gap * 2 + fs, dateY - SIGN_SPACE);
    c.fillStyle = "#111"; c.font = `bold ${Math.max(fs * 1.2, 40 * u)}px ${FONT}`; c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(signNames[0], lx + B.leftW * 0.25, sy);
    c.fillText(signNames[1], lx + B.leftW * 0.75, sy);
    c.fillStyle = "#2f4f8f"; c.font = `${Math.max(fs * 1.25, 42 * u)}px ${FONT}`; c.textAlign = "left";
    c.fillText(ctx.fmt(dateOf(tab)), lx + fs, dateY);
    return cv;
  }
  const fileBase = (tab) => `${tab === "A" ? "KeHoachTuan" : "BaoCaoTuan"}_${P().id}_${tab === "A" ? nxtStart() : curStart()}`;
  async function exportPng() {
    try {
      const cv = await renderPage(W.tab, 3840, 2160), a = document.createElement("a");
      a.download = fileBase(W.tab) + ".png"; a.href = cv.toDataURL("image/png"); a.click();
    } catch (e) { msg("Xuất ảnh lỗi: " + e.message); }
  }
  async function exportPdf() {
    try {
      msg("Đang tạo PDF…", true);
      const lib = await ctx.loadScript(ctx.JSPDF_URL, "jspdf"), cv = await renderPage(W.tab, 4200, 2970);
      const doc = new lib.jsPDF({ orientation: "landscape", unit: "mm", format: "a3", compress: true });
      const pw = 420, ph = 297, m = 0, k = Math.min((pw - 2 * m) / cv.width, (ph - 2 * m) / cv.height), w = cv.width * k, h = cv.height * k;
      doc.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", (pw - w) / 2, (ph - h) / 2, w, h, undefined, "FAST");
      doc.setProperties({ title: titleOf(W.tab), creator: "CFTN" });
      doc.save(fileBase(W.tab) + ".pdf");
      msg("Đã xuất PDF.", true);
    } catch (e) { msg("Xuất PDF lỗi: " + e.message); }
  }

  // ---------- Gắn sự kiện thanh công cụ ----------
  function bind() {
    $("wkPrev").onclick = () => setStart(addDays(W.start, -7));
    $("wkNext").onclick = () => setStart(addDays(W.start, 7));
    $("wkStart").onchange = (e) => setStart(e.target.value);
    $("zRect").onclick = () => setTool(W.tool === "rect" ? null : "rect");
    $("zPoly").onclick = () => setTool(W.tool === "poly" ? null : "poly");
    $("zDone").onclick = closePoly;
    $("zEdit").onclick = () => {
      setTool(W.tool === "edit" ? null : "edit");
      if (W.tool === "edit") msg("Sửa vùng: bấm vào vùng để chọn · kéo chấm tròn đặc để dời đỉnh · kéo chấm rỗng giữa cạnh để thêm đỉnh · Alt + bấm đỉnh để xoá đỉnh · kéo bên trong vùng để di chuyển cả vùng.", true);
    };
    $("zCancel").onclick = () => setTool(null);
    $("wkColor").onchange = (e) => { W.colored = e.target.checked; applyAsof(); };
    // Chỉ vẽ lại bảng khi con trỏ rời hẳn khỏi bảng (không làm mất ô đang nhập)
    $("wksec").addEventListener("focusout", (e) => {
      const to = e.relatedTarget;
      if (to && to.closest && to.closest("#wksec")) return;
      setTimeout(() => {
        const a = document.activeElement;
        if (W.pendingRender && !(a && a.closest && a.closest("#wksec"))) render();
      }, 0);
    });
    $("wkPng").onclick = exportPng;
    $("wkPdf").onclick = exportPdf;
    document.addEventListener("keydown", (e) => {
      if (!W.active || W.tool !== "poly") return;
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.key === "Enter") { e.preventDefault(); closePoly(); }
      else if (e.key === "Escape") setTool(null);
      else if (e.key === "Backspace" && W.draft.length) { e.preventDefault(); W.draft.pop(); setTool("poly"); }
    });
  }

  return {
    get active() { return W.active; },
    bind, setActive, stop,
    onProject() { setTool(null); if (W.active) { watch(); applyAsof(); render(); drawZones(); } },
    onData() { if (W.active) requestRender(); },
    drawZones,
    wantsRect: () => W.active && W.tool === "rect",
    drawing: () => W.active && !!W.tool,
    addRect, tap, down, move, up,
    handleText() {
      if (W.tool === "rect") return "Vẽ vùng: kéo 1 ngón để khoanh, 2 ngón để di chuyển";
      if (W.tool === "edit") return W.selZ ? "Sửa vùng: kéo đỉnh / kéo trong vùng để di chuyển" : "Sửa vùng: chạm vào vùng cần sửa";
      if (W.tool === "poly") return `Vẽ đa giác: ${W.draft.length} đỉnh – chạm đỉnh đầu để đóng`;
      return W.tab === "A" ? `Kế hoạch tuần ${dm(nxtStart())} – ${dm(nxtEnd())}` : `Báo cáo tuần ${dm(curStart())} – ${dm(curEnd())}`;
    },
  };
}
