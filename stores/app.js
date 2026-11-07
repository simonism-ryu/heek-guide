/* HEEK 안경점 찾기 · 외부 지도 API 없이 SVG 행정구역 지도 + 매장 좌표 */
(() => {
  'use strict';
  const CFG = {
    buy: 'https://smartstore.naver.com/moremetaglass',
    guide: 'https://simonism-ryu.github.io/heek-guide/',
    report: '' // 구글 폼 주소(매장 번호 자동 입력용). 비어 있으면 신고 링크를 숨김
  };
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

  const stage = $('#stage'), svg = $('#map'), overlay = $('#overlay');
  const gSido = $('#gSido'), gSgg = $('#gSgg'), gDong = $('#gDong');
  const S = {
    nat: null, proj: null, stores: [], byId: new Map(), sido: new Map(), sgg: new Map(),
    cntSido: new Map(), cntSgg: new Map(), storesBySgg: new Map(),
    places: null, placesLoading: null, dong: new Map(),
    view: { cx: 0, cy: 0, s: 1 }, home: null, minS: .1, maxS: 300,
    sel: { sido: null, sgg: null, store: null }, origin: null, limit: 8,
  };
  if (location.search.includes('debug')) window.__S = S;

  /* ---------- 좌표 ---------- */
  const P = (lon, lat) => [(lon - S.proj.lon0) * S.proj.cos * S.proj.k, (S.proj.lat0 - lat) * S.proj.k];
  const size = () => { const r = stage.getBoundingClientRect(); return { W: r.width, H: r.height }; };
  const isDesktop = () => matchMedia('(min-width: 1024px)').matches;
  function pads() {
    if (isDesktop()) return { t: 48, r: 90, b: 56, l: 48 };
    const { H } = size();
    const f = $('#finder').getBoundingClientRect();
    return { t: f.bottom + 18, r: 26, b: H - sheetTop() + 26, l: 26 };
  }
  function avail() { const { W, H } = size(); const p = pads(); return { W, H, p, aw: Math.max(120, W - p.l - p.r), ah: Math.max(120, H - p.t - p.b) }; }
  const clampS = (s) => Math.min(S.maxS, Math.max(S.minS, s));
  function toScreen(x, y) { const { W, H } = size(); const v = S.view; return [(x - v.cx) * v.s + W / 2, (y - v.cy) * v.s + H / 2]; }
  function toWorld(px, py) { const { W, H } = size(); const v = S.view; return [(px - W / 2) / v.s + v.cx, (py - H / 2) / v.s + v.cy]; }
  function fit(bb, maxS) {
    const { W, H, p, aw, ah } = avail();
    let s = Math.min(aw / Math.max(bb[2] - bb[0], .6), ah / Math.max(bb[3] - bb[1], .6));
    if (maxS) s = Math.min(s, maxS);
    s = clampS(s);
    const sx = p.l + aw / 2, sy = p.t + ah / 2;
    return { s, cx: (bb[0] + bb[2]) / 2 - (sx - W / 2) / s, cy: (bb[1] + bb[3]) / 2 - (sy - H / 2) / s };
  }
  function applyView() {
    const { W, H } = size(); const v = S.view; const w = W / v.s, h = H / v.s;
    svg.setAttribute('viewBox', `${v.cx - w / 2} ${v.cy - h / 2} ${w} ${h}`);
    renderOverlay();
  }
  let raf = 0;
  function animateTo(t, dur = 480) {
    cancelAnimationFrame(raf);
    if (reduceMotion) { S.view = t; applyView(); settled(); return; }
    const f = { ...S.view }, t0 = performance.now();
    const ls0 = Math.log(f.s), ls1 = Math.log(t.s);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      S.view = { s: Math.exp(ls0 + (ls1 - ls0) * e), cx: f.cx + (t.cx - f.cx) * e, cy: f.cy + (t.cy - f.cy) * e };
      applyView();
      if (k < 1) raf = requestAnimationFrame(step); else settled();
    };
    raf = requestAnimationFrame(step);
  }
  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtKm = (d) => d < 1 ? `${Math.round(d * 100) * 10}m` : d < 10 ? `${d.toFixed(1)}km` : `${Math.round(d)}km`;
  const tier = (n, a) => n <= 0 ? '' : n < a[0] ? 'f1' : n < a[1] ? 'f2' : 'f3';
  const sggShort = (name) => name.split(' ').pop();

  /* ---------- 데이터 ---------- */
  async function load() {
    const [nat, st] = await Promise.all([fetch('map/national.json').then((r) => r.json()), fetch('data/stores.json').then((r) => r.json())]);
    S.nat = nat; S.proj = nat.proj;
    nat.sido.forEach((d) => S.sido.set(d.code, d));
    nat.sgg.forEach((d) => S.sgg.set(d.code, d));
    S.stores = st.stores;
    for (const s of S.stores) {
      S.byId.set(s.id, s);
      S.cntSido.set(s.sido, (S.cntSido.get(s.sido) || 0) + 1);
      S.cntSgg.set(s.sgg, (S.cntSgg.get(s.sgg) || 0) + 1);
      if (!S.storesBySgg.has(s.sgg)) S.storesBySgg.set(s.sgg, []);
      S.storesBySgg.get(s.sgg).push(s);
    }
    $('#heroCount').textContent = S.stores.length;
    $('#loading').classList.add('done');
    drawBase();
    const all = nat.sido.reduce((b, d) => [Math.min(b[0], d.bb[0]), Math.min(b[1], d.bb[1]), Math.max(b[2], d.bb[2]), Math.max(b[3], d.bb[3])], [1e9, 1e9, -1e9, -1e9]);
    S.homeBB = all;
    S.home = fit(all);
    S.minS = S.home.s * .75; S.maxS = Math.max(60, size().W / 1.2);
    S.view = { ...S.home };
    applyView();
    route(true);
  }
  function loadPlaces() {
    if (S.places) return Promise.resolve(S.places);
    if (!S.placesLoading) S.placesLoading = fetch('data/places.json').then((r) => r.json()).then((p) => {
      for (const x of p) { x.k = norm(x.n); x.k2 = x.k.replace(/\d+|제(?=\d)/g, ''); }
      S.places = p; return p;
    });
    return S.placesLoading;
  }
  function loadDong(sido) {
    if (S.dong.has(sido)) return;
    S.dong.set(sido, 'loading');
    fetch(`map/dong-${sido}.json`).then((r) => r.json()).then((arr) => {
      S.dong.set(sido, arr);
      const frag = document.createDocumentFragment();
      for (const d of arr) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d.d); p.setAttribute('class', 'dong'); p.dataset.sgg = d.sgg; frag.appendChild(p); }
      const g = document.createElementNS(NS, 'g'); g.dataset.sido = sido; g.appendChild(frag); gDong.appendChild(g);
      renderOverlay();
    }).catch(() => S.dong.delete(sido));
  }

  /* ---------- 지도 그리기 ---------- */
  function drawBase() {
    const f1 = document.createDocumentFragment(), f2 = document.createDocumentFragment();
    for (const d of S.nat.sido) {
      const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d.d); p.dataset.sido = d.code; p.setAttribute('class', 'sido'); f1.appendChild(p); d.el = p;
    }
    for (const d of S.nat.sgg) {
      const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d.d); p.dataset.sgg = d.code; p.setAttribute('class', 'sgg'); p.style.display = 'none'; f2.appendChild(p); d.el = p;
    }
    gSido.appendChild(f1); gSgg.appendChild(f2);
  }
  const pool = new Map();
  function node(key, cls, html) {
    let el = pool.get(key);
    if (!el) { el = document.createElement('div'); el.dataset.k = key; overlay.appendChild(el); pool.set(key, el); el._h = null; }
    if (el.className !== cls) el.className = cls;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
    el._live = true;
    return el;
  }
  function boxPx(bb) { const a = toScreen(bb[0], bb[1]), b = toScreen(bb[2], bb[3]); return [a[0], a[1], b[0], b[1]]; }
  function relax(items, maxD) {
    // 원은 w = h = 2r, 알약은 실제 가로 · 세로 상자로 겹침을 풀어 준다
    for (const t of items) { if (!t.w) { t.w = t.h = t.r * 2; } }
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const A = items[i], B = items[j];
        let dx = B.x - A.x, dy = B.y - A.y;
        const ox = (A.w + B.w) / 2 + 4 - Math.abs(dx), oy = (A.h + B.h) / 2 + 4 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        if (A.round && B.round) { const d = Math.hypot(dx, dy), min = A.r + B.r + 3; if (d >= min) continue; }
        if (dx === 0 && dy === 0) { dx = (i % 2 ? 1 : -1); dy = 0; }
        if (oy < ox) { const s = (dy >= 0 ? 1 : -1) * oy / 2; A.y -= s; B.y += s; }
        else { const s = (dx >= 0 ? 1 : -1) * ox / 2; A.x -= s; B.x += s; }
        moved = true;
      }
      for (const t of items) { const ex = t.x - t.ox, ey = t.y - t.oy, e = Math.hypot(ex, ey); if (e > maxD) { t.x = t.ox + ex / e * maxD; t.y = t.oy + ey / e * maxD; } }
      if (!moved) break;
    }
  }
  const rad = (n) => Math.max(n >= 20 ? 21 : 17, (String(n).length * 9 + 18) / 2);
  function renderOverlay() {
    if (!S.nat) return;
    const AV = avail(); const { W, H } = AV; const s = S.view.s;
    if (!W || !H) return;
    for (const el of pool.values()) el._live = false;
    const placed = [];
    const hit = (x, y, w, h) => { for (const r of placed) if (Math.abs(r[0] - x) * 2 < r[2] + w && Math.abs(r[1] - y) * 2 < r[3] + h) return true; return false; };
    const room = (x, y, w, h) => { if (hit(x, y, w, h)) return false; placed.push([x, y, w, h]); return true; };
    const onScreen = (x, y, m = 60) => x > -m && y > -m && x < W + m && y < H + m;
    const minSide = Math.min(AV.aw, AV.ah);
    const bubbles = [], labels = [], pins = [], deepSidos = [], pinMode = [];
    for (const d of S.nat.sido) {
      const bx = boxPx(d.bb), side = Math.max(bx[2] - bx[0], bx[3] - bx[1]);
      const n = S.cntSido.get(d.code) || 0;
      d.deep = side >= Math.max(230, .62 * minSide);
      const dim = S.sel.sido && S.sel.sido !== d.code;
      d.el.setAttribute('class', `sido ${d.deep ? '' : dim ? 'dim' : tier(n, [5, 20])}`);
      if (d.deep) { deepSidos.push(d.code); continue; }
      const [x, y] = toScreen(d.lp[0], d.lp[1]);
      if (!onScreen(x, y)) continue;
      if (n > 0) { const w = d.short.length * 13.5 + String(n).length * 8.5 + 47; bubbles.push({ key: `b:${d.code}`, act: `sido:${d.code}`, n, name: d.short, pill: true, x, y, ox: x, oy: y, w, h: 32, r: 16 }); }
      else labels.push({ key: `l:${d.code}`, text: d.short, x, y });
    }
    for (const d of S.nat.sgg) {
      const parentDeep = S.sido.get(d.sido).deep;
      d.el.style.display = parentDeep ? '' : 'none';
      if (!parentDeep) continue;
      const n = S.cntSgg.get(d.code) || 0;
      const bx = boxPx(d.bb), side = Math.max(bx[2] - bx[0], bx[3] - bx[1]);
      const pm = side >= Math.max(170, .5 * minSide);
      d.el.setAttribute('class', `sgg ${pm ? (S.sel.sgg === d.code ? 'f1' : '') : tier(n, [2, 5])}${S.sel.sgg === d.code ? ' on' : ''}`);
      if (bx[2] < -40 || bx[3] < -40 || bx[0] > W + 40 || bx[1] > H + 40) continue;
      if (pm) { pinMode.push(d); continue; }
      const [x, y] = toScreen(d.lp[0], d.lp[1]);
      if (n > 0) bubbles.push({ key: `b:${d.code}`, act: `sgg:${d.code}`, n, name: sggShort(d.name), sm: true, round: true, x, y, ox: x, oy: y, r: Math.max(13, (String(n).length * 8 + 12) / 2) });
      else if (side > 46) labels.push({ key: `l:${d.code}`, text: sggShort(d.name), x, y });
    }
    if (pinMode.length) {
      new Set(pinMode.map((d) => d.sido)).forEach(loadDong);
      if (s >= 16 && !S.places) loadPlaces().then(() => requestAnimationFrame(renderOverlay));
      for (const d of pinMode) for (const st of S.storesBySgg.get(d.code) || []) {
        const [x, y] = toScreen(st.x, st.y);
        if (onScreen(x, y, 30)) { const sel = st.id === S.sel.store; pins.push({ st, sel, round: true, x, y, ox: x, oy: y, r: sel ? 13 : 9 }); }
      }
    }
    relax(bubbles, 58); relax(pins, 18);
    bubbles.sort((a, b) => b.n - a.n);
    pins.sort((a, b) => (b.sel ? 1 : 0) - (a.sel ? 1 : 0));
    for (const b of bubbles) placed.push([b.x, b.y, b.w, b.h]);
    for (const p of pins) placed.push([p.x, p.y, p.r * 2, p.r * 2]);
    for (const b of bubbles) {
      if (b.pill) {
        const el = node(b.key, 'bubble pill', `<small>${esc(b.name)}</small><b>${b.n}</b>`);
        el.dataset.act = b.act; el.style.transform = `translate(${b.x}px,${b.y}px)`;
        continue;
      }
      const el = node(b.key, `bubble${b.sm ? ' sm' : b.n >= 20 ? ' lg' : ''}`, `${b.n}<em>${esc(b.name)}</em>`);
      el.dataset.act = b.act;
      el.style.transform = `translate(${b.x}px,${b.y}px)`;
      el.querySelector('em').style.visibility = room(b.x, b.y + b.r + 9, b.name.length * 11.5 + 6, 15) ? '' : 'hidden';
    }
    for (const p of pins) {
      const showName = p.sel || (s >= 20 && room(p.x, p.y + 22, Math.min(p.st.n.length, 16) * 12.5 + 16, 22));
      const el = node(`p:${p.st.id}`, `pin${p.sel ? ' sel' : ''}`, showName ? `<span>${esc(p.st.n)}</span>` : '');
      el.dataset.act = `store:${p.st.id}`;
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
      el.style.zIndex = p.sel ? 3 : '';
    }
    for (const l of labels) if (room(l.x, l.y, l.text.length * 12 + 6, 16)) { const el = node(l.key, 'lbl', esc(l.text)); el.style.transform = `translate(${l.x}px,${l.y}px)`; }
    if (pinMode.length && S.places && s >= 16) {
      const inSgg = new Set(pinMode.map((d) => d.code));
      for (const pl of S.places) {
        if (pl.t !== 'dong' || !inSgg.has(pl.sgg)) continue;
        const [wx, wy] = P(pl.lon, pl.lat); const [x, y] = toScreen(wx, wy);
        if (!onScreen(x, y, 0)) continue;
        if (room(x, y, pl.n.length * 11 + 6, 15)) { const el = node(`d:${pl.sgg}:${pl.n}`, 'lbl dongl', esc(pl.n)); el.style.transform = `translate(${x}px,${y}px)`; }
      }
    }
    for (const g of gDong.children) g.style.display = deepSidos.includes(g.dataset.sido) ? '' : 'none';
    if (S.origin) {
      const [wx, wy] = P(S.origin.lon, S.origin.lat); const [x, y] = toScreen(wx, wy);
      const el = node('me', `me${S.origin.type === 'gps' ? '' : ' place'}`, ''); el.style.transform = `translate(${x}px,${y}px)`;
    }
    for (const [k, el] of pool) if (!el._live) { el.remove(); pool.delete(k); }
    placePop();
  }
  function settled() { renderOverlay(); }
  /* PC: 고른 매장 핀 오른쪽에 요약 팝업, 자세한 내용은 왼쪽 패널 */
  const pop = $('#pop');
  function fillPop(st) {
    const d = S.origin ? km(S.origin, st) : null;
    const tel = (st.t || '').replace(/[^0-9]/g, '');
    const region = `${S.sido.get(st.sido)?.short || ''} ${sggShort(S.sgg.get(st.sgg)?.name || '')} ${st.dong}`.trim();
    pop.innerHTML = `<button class="x" data-popx aria-label="닫기"><i class="ph ph-x"></i></button>
      <h3>${esc(st.n)}</h3>
      <div class="pop-meta">${d != null ? `<span class="chip">${fmtKm(d)}</span>` : ''}<span>${esc(region)}</span></div>
      <p>${esc(st.a)}</p>
      ${tel ? `<a class="pop-tel" href="tel:${tel}"><i class="ph ph-phone"></i> ${esc(st.t)}</a>` : ''}
      <div class="pop-act"><a class="go" href="${esc(st.url)}" target="_blank" rel="noopener">네이버 지도<i class="ph ph-arrow-up-right"></i></a><button class="more" data-popmore>자세히 보기</button></div>`;
    pop.dataset.id = st.id;
  }
  function placePop() {
    if (!isDesktop() || !S.popOpen || !S.sel.store) { pop.hidden = true; return; }
    const st = S.byId.get(S.sel.store); if (!st) { pop.hidden = true; return; }
    if (pop.dataset.id !== st.id) fillPop(st);
    const { W, H } = size(); const [x, y] = toScreen(st.x, st.y);
    if (x < -20 || y < -20 || x > W + 20 || y > H + 20) { pop.hidden = true; return; }
    pop.hidden = false;
    const pw = pop.offsetWidth || 280, ph = pop.offsetHeight || 180;
    const right = x + 22 + pw < W - 12;
    const px = right ? x + 22 : x - 22 - pw;
    const py = Math.min(Math.max(12, y - 26), H - ph - 12);
    pop.className = `pop ${right ? 'right' : 'left'}`;
    pop.style.transform = `translate(${Math.round(px)}px,${Math.round(py)}px)`;
    pop.style.setProperty('--arrow', `${y - py}px`);
  }
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  pop.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  pop.addEventListener('click', (e) => {
    if (e.target.closest('[data-popx]')) { S.popOpen = false; placePop(); }
    else if (e.target.closest('[data-popmore]')) { $('#sheetBody').scrollTop = 0; $('#panel').querySelector('.detail h2')?.scrollIntoView({ block: 'nearest' }); const h2 = document.querySelector('.detail h2'); if (h2) { h2.animate([{ background: 'var(--accent-soft)' }, { background: 'transparent' }], { duration: 900 }); } }
  });

  /* ---------- 지도 조작 ---------- */
  const ptrs = new Map(); let gesture = null; let downTarget = null; let moved = 0;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zoom')) return;
    cancelAnimationFrame(raf);
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size === 1) { downTarget = e.target; moved = 0; }
    gesture = null;
  });
  stage.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    const r = stage.getBoundingClientRect();
    if (ptrs.size === 1) {
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
      S.view.cx -= dx / S.view.s; S.view.cy -= dy / S.view.s; applyView();
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const mid = [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (gesture) {
        const [wx, wy] = toWorld(gesture.mid[0], gesture.mid[1]);
        const ns = clampS(S.view.s * dist / gesture.dist);
        const { W, H } = size();
        S.view = { s: ns, cx: wx - (mid[0] - W / 2) / ns, cy: wy - (mid[1] - H / 2) / ns };
        applyView();
      }
      gesture = { mid, dist }; moved = 99;
    }
  });
  const endPtr = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size === 0) {
      if (moved < 7 && downTarget) tap(downTarget);
      downTarget = null; gesture = null; settled();
    } else gesture = null;
  };
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault(); cancelAnimationFrame(raf);
    const r = stage.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    const [wx, wy] = toWorld(px, py); const ns = clampS(S.view.s * Math.exp(-e.deltaY * (e.ctrlKey ? .01 : .0018)));
    const { W, H } = size(); S.view = { s: ns, cx: wx - (px - W / 2) / ns, cy: wy - (py - H / 2) / ns }; applyView();
    clearTimeout(S._wt); S._wt = setTimeout(settled, 120);
  }, { passive: false });
  function zoomBy(f) {
    const { W, H, p, aw, ah } = avail(); const px = p.l + aw / 2, py = p.t + ah / 2;
    const [wx, wy] = toWorld(px, py); const ns = clampS(S.view.s * f);
    animateTo({ s: ns, cx: wx - (px - W / 2) / ns, cy: wy - (py - H / 2) / ns }, 380);
  }
  $('#zoomIn').addEventListener('click', () => zoomBy(2));
  $('#zoomOut').addEventListener('click', () => zoomBy(.5));
  $('#zoomHome').addEventListener('click', () => go({}, true));
  function tap(t) {
    const act = t.closest && t.closest('[data-act]');
    if (act) { const [k, v] = act.dataset.act.split(':'); if (k === 'sido') go({ sido: v }); else if (k === 'sgg') go({ sido: S.sgg.get(v).sido, sgg: v }); else go({ store: v }); return; }
    if (t.dataset && t.dataset.sgg && t.classList.contains('sgg')) { go({ sido: S.sgg.get(t.dataset.sgg).sido, sgg: t.dataset.sgg }); return; }
    if (t.dataset && t.dataset.sido) go({ sido: t.dataset.sido });
  }

  /* ---------- 화면 상태(지역 선택 · 매장 · 기준 위치) ---------- */
  function go(sel, push = true, opts = {}) {
    if (!opts.keepOrigin) S.origin = null;
    S.sel = { sido: sel.sido || null, sgg: sel.sgg || null, store: sel.store || null };
    S.limit = 8;
    S.popOpen = !!S.sel.store;
    if (S.sel.store) {
      const st = S.byId.get(S.sel.store); if (!st) return go({});
      S.sel.sido = st.sido; S.sel.sgg = st.sgg;
      const target = Math.max(S.view.s, isDesktop() ? 60 : 70);
      const { W, H, p, aw, ah } = avail();
      animateTo({ s: target, cx: st.x - (p.l + aw / 2 - W / 2) / target, cy: st.y - (p.t + ah / 2 - H / 2) / target });
      setSheet('half');
    } else if (S.sel.sgg) {
      const d = S.sgg.get(S.sel.sgg); const list = S.storesBySgg.get(S.sel.sgg) || [];
      let bb = d.bb;
      if (list.length) { const xs = list.map((s) => s.x), ys = list.map((s) => s.y); const sb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        bb = [Math.max(bb[0], sb[0] - 3), Math.max(bb[1], sb[1] - 3), Math.min(bb[2], sb[2] + 3), Math.min(bb[3], sb[3] + 3)]; }
      const v = fit(bb, 160);
      const need = 175 / Math.max(d.bb[2] - d.bb[0], d.bb[3] - d.bb[1]);
      v.s = Math.max(v.s, Math.min(need, S.maxS));
      animateTo(v); setSheet('half');
    } else if (S.sel.sido) {
      animateTo(fit(S.sido.get(S.sel.sido).bb)); setSheet('peek');
    } else if (!opts.keepOrigin) {
      animateTo(fit(S.homeBB)); setSheet('peek');
    }
    if (push) { const h = hashOf(); if (location.hash !== h) history.pushState(null, '', h || location.pathname); }
    renderPanel();
  }
  function hashOf() {
    if (S.sel.store) return `#/s/${S.sel.store}`;
    if (S.sel.sgg) return `#/r/${S.sel.sido}/${S.sel.sgg}`;
    if (S.sel.sido) return `#/r/${S.sel.sido}`;
    return '';
  }
  function route(first) {
    if (location.hash === '#/near' && S.lastOrigin) { S.sel = { sido: null, sgg: null, store: null }; S.origin = S.lastOrigin; renderPanel(); renderOverlay(); return; }
    const m = location.hash.match(/^#\/(r|s)\/([^/]+)(?:\/([^/]+))?/);
    if (!m) { go({}, false); return; }
    if (m[1] === 's') go({ store: decodeURIComponent(m[2]) }, false);
    else go({ sido: m[2], sgg: m[3] }, false);
  }
  addEventListener('popstate', () => route());

  function setOrigin(o) {
    S.origin = o; S.lastOrigin = o; S.sel = { sido: null, sgg: null, store: null }; S.limit = 8;
    const near = nearest(o, 3); const [ox, oy] = P(o.lon, o.lat);
    const xs = [ox, ...near.map((n) => n.st.x)], ys = [oy, ...near.map((n) => n.st.y)];
    const v = fit([Math.min(...xs) - 1.2, Math.min(...ys) - 1.2, Math.max(...xs) + 1.2, Math.max(...ys) + 1.2], 120);
    v.s = Math.max(v.s, Math.min(S.maxS, 22));
    animateTo(v); setSheet('half'); renderPanel();
    history.pushState(null, '', location.pathname + '#/near');
  }
  function nearest(o, n) {
    return S.stores.map((st) => ({ st, d: km(o, st) })).sort((a, b) => a.d - b.d).slice(0, n);
  }

  /* ---------- 패널(시트) ---------- */
  const tplNotice = $('#tplNotice').innerHTML;
  function crumbs() {
    const c = [`<button data-go="home" ${!S.sel.sido && !S.origin ? 'aria-current="page"' : ''}>전국</button>`];
    if (S.origin && !S.sel.store) c.push('<span class="sep">›</span>', `<button aria-current="page">${esc(S.origin.label)} 주변</button>`);
    if (S.sel.sido) c.push('<span class="sep">›</span>', `<button data-go="sido" ${!S.sel.sgg ? 'aria-current="page"' : ''}>${esc(S.sido.get(S.sel.sido).short)}</button>`);
    if (S.sel.sgg) c.push('<span class="sep">›</span>', `<button data-go="sgg" ${!S.sel.store ? 'aria-current="page"' : ''}>${esc(S.sgg.get(S.sel.sgg).name)}</button>`);
    $('#crumbs').innerHTML = c.join('');
  }
  function storeCard(st, d) {
    const tel = (st.t || '').replace(/[^0-9]/g, '');
    return `<li class="store-wrap"><button class="store" data-store="${esc(st.id)}"><h3>${esc(st.n)}</h3>${d != null ? `<span class="dist">${fmtKm(d)}</span>` : ''}<p>${esc(st.a)}</p></button><div class="quick">${tel ? `<a href="tel:${tel}"><i class="ph ph-phone"></i>전화</a>` : ''}<a href="${esc(st.url)}" target="_blank" rel="noopener"><i class="ph ph-navigation-arrow"></i>길찾기</a></div></li>`;
  }
  function renderPanel() {
    crumbs();
    const head = $('#sheetHead'), body = $('#sheetBody');
    body.scrollTop = 0;
    if (S.sel.store) { head.innerHTML = ''; body.innerHTML = detail(S.byId.get(S.sel.store)); return; }
    if (S.origin) {
      const list = nearest(S.origin, 30);
      head.innerHTML = `<h2>${esc(S.origin.label)} 가까운 안경점</h2><p>직선거리 기준, 가까운 순</p>`;
      body.innerHTML = `<ul class="stores">${list.slice(0, S.limit).map((x) => storeCard(x.st, x.d)).join('')}</ul>${S.limit < list.length ? '<button class="more" data-more>더 보기</button>' : ''}${tplNotice}`;
      return;
    }
    if (S.sel.sgg) {
      const d = S.sgg.get(S.sel.sgg); const list = (S.storesBySgg.get(S.sel.sgg) || []).slice().sort((a, b) => a.n.localeCompare(b.n, 'ko'));
      head.innerHTML = `<h2>${esc(S.sido.get(S.sel.sido).short)} ${esc(d.name)}</h2><p>도수렌즈 제작 가능 안경점 ${list.length}곳</p>`;
      body.innerHTML = list.length ? `<ul class="stores">${list.map((st) => storeCard(st)).join('')}</ul>${tplNotice}` : emptyBox(d.lp);
      return;
    }
    if (S.sel.sido) {
      const d = S.sido.get(S.sel.sido); const n = S.cntSido.get(d.code) || 0;
      const rows = S.nat.sgg.filter((g) => g.sido === d.code).map((g) => ({ g, n: S.cntSgg.get(g.code) || 0 })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n || a.g.name.localeCompare(b.g.name, 'ko'));
      head.innerHTML = `<h2>${esc(d.name)} ${n}곳</h2><p>시·군·구를 고르면 매장이 보여요</p>`;
      body.innerHTML = rows.length ? `<ul class="rows">${rows.map((r) => `<li><button class="row" data-sgg="${r.g.code}"><b>${esc(r.g.name)}</b><span class="count">${r.n}</span><i class="ph ph-caret-right"></i></button></li>`).join('')}</ul>${tplNotice}` : emptyBox(d.lp);
      return;
    }
    const rows = S.nat.sido.map((d) => ({ d, n: S.cntSido.get(d.code) || 0 })).sort((a, b) => b.n - a.n);
    head.innerHTML = `<div class="head-brand"><div><img class="logo-m" src="assets/brand/logo.png" alt="HEEK 히크" width="74" height="20"><h2>전국 ${S.stores.length}곳에서 맞출 수 있어요</h2><p>히크 렌즈가이드 도수렌즈 제작 가능 안경점</p></div><img class="head-char" src="assets/brand/ttoryeot-wave.webp" alt="" width="58" height="71"></div>`;
    body.innerHTML = `<ul class="rows">${rows.map((r) => `<li><button class="row${r.n ? '' : ' zero'}" data-sido="${r.d.code}"><b>${esc(r.d.name)}</b><span class="count">${r.n}</span><i class="ph ph-caret-right"></i></button></li>`).join('')}</ul>${tplNotice}`;
  }
  function emptyBox(lp) {
    S._emptyLp = lp;
    return `<div class="empty-box"><img src="assets/brand/ttoryeot-dizzy.webp" alt="" width="92" height="88" loading="lazy"><b>이 지역은 아직 목록에 있는 안경점이 없어요</b>목록에 없는 동네 안경점에서도 렌즈가이드를 보여 주면 맞출 수 있는 경우가 많아요.</div><button class="cta ghost" data-nearlp>가장 가까운 목록 안경점 보기</button>${tplNotice}`;
  }
  function detail(st) {
    const d = S.origin ? km(S.origin, st) : null;
    const region = `${S.sido.get(st.sido)?.short || ''} ${S.sgg.get(st.sgg)?.name || ''}`.trim();
    const tel = (st.t || '').replace(/[^0-9]/g, '');
    return `<div class="detail">
      <button class="back" data-back><i class="ph ph-caret-left"></i>목록으로</button>
      <h2>${esc(st.n)}</h2>
      <div class="meta">${d != null ? `<span class="chip">${fmtKm(d)}</span>` : ''}<span>${esc(region)} ${esc(st.dong)}</span></div>
      <ul class="info">
        <li><i class="ph ph-map-pin"></i><span>${esc(st.a)}</span><button class="mini" data-copy="${esc(st.a)}">복사</button></li>
        ${tel ? `<li><i class="ph ph-phone"></i><a href="tel:${tel}">${esc(st.t)}</a><a class="mini" href="tel:${tel}">전화</a></li>` : ''}
      </ul>
      <div class="actions">
        <a class="cta" href="${esc(st.url)}" target="_blank" rel="noopener">네이버 지도<i class="ph ph-arrow-up-right"></i></a>
        ${tel ? `<a class="cta ghost" href="tel:${tel}">전화하기</a>` : `<button class="cta ghost" data-copy="${esc(st.a)}">주소 복사</button>`}
      </div>
      <div class="tip"><img class="tip-char" src="assets/brand/ttoryeot-happy.webp" alt="" width="44" height="40" loading="lazy"><div><b>방문 팁</b>전화로 묻기보다 렌즈가이드를 들고 가서 안경사님께 데모렌즈를 보여 주세요. 렌즈 재고가 있으면 30분 내외로 제작돼요. <a href="${CFG.guide}" target="_blank" rel="noopener">안경사용 안내 보기</a></div></div>
      ${tplNotice}
      ${CFG.report ? `<a class="report" href="${CFG.report}${encodeURIComponent(st.id)}" target="_blank" rel="noopener"><i class="ph ph-flag"></i>정보가 다르거나 제작을 거절당했어요</a>` : ''}
    </div>`;
  }
  $('#crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]'); if (!b) return;
    if (b.dataset.go === 'home') go({}); else if (b.dataset.go === 'sido') go({ sido: S.sel.sido }); else go({ sido: S.sel.sido, sgg: S.sel.sgg });
  });
  $('#sheetBody').addEventListener('click', (e) => {
    const t = e.target.closest('button, a'); if (!t) return;
    if (t.dataset.sido) go({ sido: t.dataset.sido });
    else if (t.dataset.sgg) go({ sido: S.sgg.get(t.dataset.sgg).sido, sgg: t.dataset.sgg });
    else if (t.dataset.store) { const o = S.origin; go({ store: t.dataset.store }, true, { keepOrigin: !!o }); S.origin = o; renderPanel(); }
    else if ('more' in t.dataset) { S.limit += 10; renderPanel(); }
    else if ('back' in t.dataset) history.length > 1 ? history.back() : go({});
    else if ('copy' in t.dataset) { navigator.clipboard?.writeText(t.dataset.copy).then(() => toast('주소를 복사했어요'), () => toast('복사하지 못했어요')); }
    else if ('nearlp' in t.dataset && S._emptyLp) {
      const lp = S._emptyLp; const lon = lp[0] / (S.proj.cos * S.proj.k) + S.proj.lon0, lat = S.proj.lat0 - lp[1] / S.proj.k;
      setOrigin({ lon, lat, label: S.sel.sgg ? sggShort(S.sgg.get(S.sel.sgg).name) : S.sido.get(S.sel.sido).short, type: 'place' });
    }
  });

  /* ---------- 내 주변 ---------- */
  $('#nearBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { toast('이 브라우저는 위치 기능을 지원하지 않아요. 동네 이름으로 찾아 주세요'); return; }
    const btn = $('#nearBtn'); btn.classList.add('on');
    navigator.geolocation.getCurrentPosition((pos) => {
      const o = { lon: pos.coords.longitude, lat: pos.coords.latitude, label: '내 위치', type: 'gps' };
      if (o.lat < 33 || o.lat > 39 || o.lon < 124 || o.lon > 132) { btn.classList.remove('on'); toast('국내 위치에서만 가까운 매장을 찾을 수 있어요'); return; }
      setOrigin(o);
    }, () => { btn.classList.remove('on'); toast('위치를 확인하지 못했어요. 동네나 주소를 입력해 주세요'); $('#q').focus(); }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 });
  });

  /* ---------- 검색 ---------- */
  const q = $('#q'), sug = $('#suggest'); let sugItems = [], sugIdx = -1;
  q.addEventListener('focus', () => { loadPlaces(); if (!isDesktop()) setSheet('peek'); });
  q.addEventListener('input', () => { $('#qClear').hidden = !q.value; suggest(); });
  $('#qClear').addEventListener('click', () => { q.value = ''; $('#qClear').hidden = true; hideSug(); q.focus(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!sugItems.length) return; sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length; paintSug(); }
    else if (e.key === 'Escape') hideSug();
  });
  $('#searchForm').addEventListener('submit', async (e) => {
    e.preventDefault(); await loadPlaces(); if (!sugItems.length) suggest();
    if (sugItems.length) pick(sugItems[Math.max(0, sugIdx)]); else toast('찾지 못했어요. 시·군·구나 동 이름으로 입력해 보세요');
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#finder')) hideSug(); });
  function hideSug() { sug.hidden = true; sugIdx = -1; }
  function tokens(v) { return v.trim().split(/[\s,]+/).filter(Boolean).map((t) => norm(t)); }
  function search(v) {
    const toks = tokens(v); if (!toks.length) return [];
    const last = toks[toks.length - 1], lastBare = last.replace(/\d+/g, '');
    const out = [];
    for (const st of S.stores) {
      const k = norm(st.n), a = norm(st.a);
      if (toks.every((t) => k.includes(t))) out.push({ type: 'store', st, score: 70 + (k.startsWith(last) ? 10 : 0) });
      else if (/(로|길)$|번길$/.test(last) && a.includes(last) && toks.every((t) => a.includes(t) || k.includes(t))) out.push({ type: 'road', st, score: 55 });
    }
    if (S.places) for (const pl of S.places) {
      const sidoS = S.sido.get(pl.sido)?.short || '';
      const hay = norm(sidoS + (S.sido.get(pl.sido)?.name || '') + (pl.t === 'dong' ? pl.sggn : '') + pl.n);
      if (!toks.slice(0, -1).every((t) => hay.includes(t.replace(/(시|군|구|도)$/, '')))) continue;
      let sc = 0;
      if (pl.k === last || pl.k2 === lastBare || (pl.t === 'sido' && norm(pl.s) === last)) sc = 100;
      else if (pl.k.startsWith(last) || pl.k2.startsWith(lastBare) || (pl.t === 'sido' && norm(pl.s).startsWith(last))) sc = 62;
      else if (last.length >= 2 && pl.k.includes(last)) sc = 35;
      if (!sc) continue;
      sc += pl.t === 'sido' ? 9 : pl.t === 'sgg' ? 6 : 0;
      out.push({ type: pl.t, pl, score: sc });
    }
    out.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return out.filter((x) => { const k = x.st ? (x.type + x.st.id) : (x.pl.t + x.pl.n + (x.pl.sgg || x.pl.sido)); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 8);
  }
  function suggest() {
    const v = q.value; if (!v.trim()) { hideSug(); return; }
    sugItems = search(v); sugIdx = sugItems.length ? 0 : -1;
    if (!S.places) loadPlaces().then(() => { if (q.value === v) suggest(); });
    paintSug();
  }
  function paintSug() {
    if (!q.value.trim()) return hideSug();
    sug.hidden = false;
    if (!sugItems.length) { sug.innerHTML = `<li class="empty">${S.places ? '맞는 지역이 없어요. 시·군·구나 동 이름으로 입력해 보세요' : '지역 목록을 불러오는 중이에요'}</li>`; return; }
    sug.innerHTML = sugItems.map((x, i) => {
      let icon, main, sub;
      if (x.type === 'store') { icon = 'ph-storefront'; main = x.st.n; sub = `${S.sido.get(x.st.sido)?.short || ''} ${sggShort(S.sgg.get(x.st.sgg)?.name || '')}`; }
      else if (x.type === 'road') { icon = 'ph-signpost'; main = x.st.a; sub = x.st.n; }
      else { icon = x.type === 'dong' ? 'ph-map-pin-simple' : 'ph-map-trifold'; main = x.pl.n; sub = x.type === 'dong' ? `${S.sido.get(x.pl.sido)?.short || ''} ${x.pl.sggn}` : x.type === 'sgg' ? (S.sido.get(x.pl.sido)?.short || '') : '시·도'; }
      return `<li role="option" data-i="${i}" aria-selected="${i === sugIdx}"><i class="ph ${icon}"></i><b>${esc(main)}</b><small>${esc(sub)}</small></li>`;
    }).join('');
  }
  sug.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(sugItems[+li.dataset.i]); });
  function pick(x) {
    hideSug(); q.blur();
    if (x.type === 'store') { go({ store: x.st.id }); return; }
    if (x.type === 'road') { setOrigin({ lon: x.st.lon, lat: x.st.lat, label: q.value.trim(), type: 'place' }); return; }
    if (x.type === 'sido') { q.value = ''; $('#qClear').hidden = true; go({ sido: x.pl.sido }); return; }
    setOrigin({ lon: x.pl.lon, lat: x.pl.lat, label: x.type === 'sgg' ? x.pl.n : x.pl.n, type: 'place' });
  }

  /* ---------- 하단 시트(모바일) ---------- */
  const sheet = $('#sheet'); let sheetState = 'peek';
  const heights = () => { const H = innerHeight; return { peek: Math.round(H * .38), half: Math.round(H * .52), full: Math.round(H * .92) }; };
  function sheetTop() { if (isDesktop()) return size().H; const r = sheet.getBoundingClientRect(); return r.top - stage.getBoundingClientRect().top; }
  function setSheet(st, px) {
    if (isDesktop()) return;
    sheetState = st || sheetState;
    const h = px ?? heights()[sheetState];
    sheet.style.transform = `translateY(${Math.round(innerHeight * .92) - h}px)`;
    document.documentElement.style.setProperty('--sheet-peek', `${Math.min(h, heights().half)}px`);
  }
  let drag = null;
  const startDrag = (e) => {
    if (isDesktop()) return;
    if (e.target.closest('button') && !e.target.closest('#grip')) return;
    drag = { y: e.clientY, start: innerHeight - sheet.getBoundingClientRect().top, t: performance.now() };
    sheet.classList.add('dragging'); e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e) => { if (!drag) return; const h = Math.max(120, Math.min(innerHeight * .92, drag.start + (drag.y - e.clientY))); setSheet(null, h); drag.cur = h; drag.v = (drag.y - e.clientY) / Math.max(1, performance.now() - drag.t); };
  const endDrag = () => {
    if (!drag) return; sheet.classList.remove('dragging');
    const h = drag.cur ?? drag.start, H = heights();
    let st = Object.entries(H).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
    if (drag.v > .6) st = h > H.half ? 'full' : 'half'; else if (drag.v < -.6) st = h < H.half ? 'peek' : 'half';
    drag = null; setSheet(st);
  };
  for (const el of [$('#grip'), $('#sheetHead'), $('#crumbs')]) {
    el.addEventListener('pointerdown', startDrag); el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag);
  }
  $('#grip').addEventListener('click', () => setSheet(sheetState === 'peek' ? 'half' : sheetState === 'half' ? 'full' : 'peek'));

  /* ---------- 기타 ---------- */
  let tt = 0;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2600); }
  addEventListener('resize', () => { setSheet(); if (!S.nat || !size().W) return; S.maxS = Math.max(60, size().W / 1.2); if (!isFinite(S.view.s) || !isFinite(S.view.cx) || S.view.s <= 0) { S.home = fit(S.homeBB); S.minS = S.home.s * .75; S.view = { ...S.home }; } applyView(); });
  setSheet('peek');
  load().catch((err) => { console.error(err); $('#sheetHead').innerHTML = '<h2>지도를 불러오지 못했어요</h2><p>잠시 후 다시 열어 주세요.</p>'; });
})();
