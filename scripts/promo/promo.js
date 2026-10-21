// Claude Code Alerts promo clips, drawn in code. Each clip is a pure function of time: render(t) sets every element.
// render.mjs steps t frame by frame and screenshots the page.

const COL = { done: '#34C759', input: '#FF9F0A', review: '#BF5AF2', error: '#FF453A', mac: '#FF453A', free: '#34C759', working: '#4C8DFF', idle: '#8A8F9A' };
const LABEL = { done: 'done', input: 'needs you', review: 'plan ready', error: 'error', mac: 'using your Mac', free: 'Mac is free' };
const DOT = { done: '🟢', input: '🟠', review: '🟣', error: '🔴' };

// ---------- math ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const out = (x) => 1 - Math.pow(1 - x, 3);
const prog = (t, a, b) => clamp((t - a) / (b - a));
const eprog = (t, a, b) => ease(prog(t, a, b));
// a soft spring for things that drop in
const spring = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.exp(-6 * x) * Math.cos(9 * x));
// keyframes: [[t, v], ...] with eased interpolation (v may be a number or an object of numbers)
function kf(t, frames) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [t1, v1] = frames[i];
    const [t0, v0] = frames[i - 1];
    if (t <= t1) {
      const k = ease((t - t0) / (t1 - t0));
      if (typeof v0 === 'number') return lerp(v0, v1, k);
      const o = {};
      for (const key in v0) o[key] = lerp(v0[key], v1[key], k);
      return o;
    }
  }
  return frames[frames.length - 1][1];
}

// ---------- dom helpers ----------
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
function el(tag, attrs = {}, html = '') {
  const e = document.createElement(tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  e.innerHTML = html;
  return e;
}
function add(parent, html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const e = t.content.firstElementChild;
  parent.appendChild(e);
  return e;
}

const ICON = {
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  go: '<path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"/>',
};

// ---------- building blocks ----------
function menubar(app) {
  add(stage, `<div id="menubar"><div class="left"><b></b><b>${app}</b><span>File</span><span>Edit</span><span>View</span><span>Window</span></div>
    <div class="right"><span id="mbicon"><span class="grid"><i></i><i></i><i></i><i></i></span><span id="mbcount"></span></span>
    <span>⌕</span><span>Wed 9:41</span></div></div>`);
  add(stage, `<div id="notch"></div>`);
  $('#menubar .left b').textContent = '';
}
function setIcon(state, count) {
  const c = state ? COL[state] : '#1f1e1d';
  document.querySelectorAll('#mbicon .grid i').forEach((i) => (i.style.background = c));
  $('#mbicon').style.background = state ? c + '26' : 'transparent';
  $('#mbcount').textContent = count ? String(count) : '';
  $('#mbcount').style.color = c;
}

function browser() {
  return add(stage, `<div class="win" id="browser">
    <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="tab">Pricing page · spec</div></div>
    <div class="url"><span>docs.demo-shop.dev/pricing-spec</span></div>
    <div class="docs">
      <div class="nav"><div class="h">PROJECT</div><div>Roadmap</div><div class="on">Pricing page · spec</div><div>Checkout</div><div>Release notes</div>
        <div class="h">TEAM</div><div>Design review</div><div>Launch plan</div></div>
      <div class="page"><h1>Pricing page</h1><div class="sub">Spec · updated today</div>
        <h2>Goal</h2><p>Three clear plans, one recommended. Visitors should understand the difference in five seconds.</p>
        <div class="tbl"><div>Free<b>$0</b></div><div>Pro<b>$9</b></div><div>Team<b>$29</b></div></div>
        <h2>Tasks</h2>
        <div class="chk"><i class="on"></i>Checkout validation</div>
        <div class="chk"><i></i>Pricing section on the landing page</div>
        <div class="chk"><i></i>Database migration for plans</div>
      </div></div></div>`);
}

function vscode(tabs, sessions, term) {
  const w = add(stage, `<div class="win" id="vscode"><div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><span>demo-shop</span><span></span></div>
    <div class="body"><div class="activity"></div>
      <div class="explorer"><div class="h">EXPLORER</div><div class="srow"><span class="n">src</span></div><div class="srow"><span class="n">README.md</span></div>
        <div class="h" style="margin-top:22px">CLAUDE SESSIONS</div><div id="sess"></div></div>
      <div class="main"><div class="tabs" id="tabs"></div><div class="term" id="term"></div>
        <div class="statusbar"><span>main</span><span id="sbcount"></span></div></div></div></div>`);
  setTabs(tabs);
  setSessions(sessions);
  $('#term').innerHTML = term;
  return w;
}
function setTabs(tabs) {
  $('#tabs').innerHTML = tabs.map((t) => `<div class="vtab${t.on ? ' on' : ''}" style="${t.style || ''}"><span class="ic"></span>${t.title}</div>`).join('');
}
function setSessions(list) {
  $('#sess').innerHTML = list.map((s) => `<div class="srow${s.on ? ' on' : ''}"><span class="d" style="background:${COL[s.state]}"></span><span class="n">${s.name}</span><span class="s">${s.label || LABEL[s.state] || s.state}</span></div>`).join('');
}
function spinner(t) { return '✻✽✶✳✢·'[Math.floor(t * 8) % 6]; }

function editor() {
  return add(stage, `<div class="win" id="editor"><div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><span style="margin-left:14px">Release notes.txt</span></div><div class="doc" id="doc"></div></div>`);
}

function overlays() {
  add(stage, `<div id="edge"></div>`);
  add(stage, `<div id="ring"></div>`);
  add(stage, `<div id="pills"></div>`);
  add(stage, `<div id="ripple"></div>`);
  add(stage, `<svg id="cursor" viewBox="0 0 26 34"><path d="M2 2 L2 27 L8.5 20.5 L13 31 L17 29.3 L12.6 19 L21.5 19 Z" fill="#000" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>`);
}

function pillHTML(p) {
  const c = COL[p.state];
  const btns = p.state === 'mac' || p.state === 'free'
    ? `<span class="b"><svg viewBox="0 0 24 24">${ICON.x}</svg></span>`
    : ['x', 'clock', 'check'].map((k) => `<span class="b"><svg viewBox="0 0 24 24">${ICON[k]}</svg></span>`).join('') +
      `<span class="b go" style="background:${c}"><svg viewBox="0 0 24 24">${ICON.go}</svg></span>`;
  return `<div class="pill" style="border:1.8px solid ${c};box-shadow:0 0 22px ${c}77">
    <span class="dot" style="background:${c}"></span>
    <span class="txt"><span class="nm">${p.name}<span class="pen">✎</span></span><span class="ds" style="color:${c}">${p.text}</span></span>
    <span class="lb" style="color:${c}">${LABEL[p.state]}</span><span class="btns">${btns}</span></div>`;
}
// pills: [{state,name,text, at (drop time), out (hide time, optional), fly: {x,y} optional target}]
function renderPills(t, pills, summary) {
  const box = $('#pills');
  let html = '';
  if (summary && t >= summary.at) {
    const k = spring(prog(t, summary.at, summary.at + 0.7));
    html += `<div class="summary" style="opacity:${clamp(k * 1.5)};transform:translateY(${(1 - k) * -30}px)">${summary.text}</div>`;
  }
  for (const p of pills) {
    if (t < p.at) continue;
    if (p.out !== undefined && t >= p.out + 0.35) continue;
    const k = spring(prog(t, p.at, p.at + 0.75));
    let o = clamp(prog(t, p.at, p.at + 0.25));
    let tr = `translateY(${(1 - k) * -46}px) scale(${0.92 + 0.08 * k})`;
    if (p.out !== undefined && t >= p.out) {
      const q = eprog(t, p.out, p.out + 0.35);
      o = 1 - q;
      tr = p.fly ? `translate(${p.fly.x * q}px, ${p.fly.y * q}px) scale(${1 - 0.85 * q})` : `scale(${1 - 0.1 * q})`;
    }
    html += `<div style="opacity:${o};transform:${tr}">${pillHTML(p)}</div>`;
  }
  box.innerHTML = html;
}
function edge(t, flares) {
  // flares: [{state, at}] short glow around the screen
  let s = '';
  for (const f of flares) {
    const a = t - f.at;
    if (a < 0 || a > 1.6) continue;
    const o = a < 0.2 ? a / 0.2 : a > 1.1 ? 1 - (a - 1.1) / 0.5 : 1;
    const c = COL[f.state];
    s = `inset 0 0 0 6px ${c}, inset 0 0 120px ${c}cc`;
    $('#edge').style.opacity = o;
  }
  $('#edge').style.boxShadow = s;
  if (!s) $('#edge').style.opacity = 0;
}
// Click targets are measured from the real elements, in stage coordinates, so the cursor tip lands exactly on them.
const TARGET = {};
function center(sel) {
  const e = document.querySelector(sel);
  if (!e || !e.offsetWidth) return null;
  let x = 0, y = 0, n = e;
  while (n && n !== stage) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x: x + e.offsetWidth / 2, y: y + e.offsetHeight / 2 };
}
function resolve(v) {
  if (!v.sel) return v;
  const c = center(v.sel);
  if (c) TARGET[v.sel] = c;
  const p = TARGET[v.sel] || { x: v.x ?? 800, y: v.y ?? 500 };
  return { x: p.x + (v.dx || 0), y: p.y + (v.dy || 0) };
}
function cursor(t, path, clicks = []) {
  const p = kf(t, path.map(([tt, v]) => [tt, resolve(v)]));
  // the arrow's tip is at (2, 2) inside the 26x34 svg
  $('#cursor').style.left = p.x - 2 + 'px';
  $('#cursor').style.top = p.y - 2 + 'px';
  let press = 1;
  let rip = 0;
  let k = 0;
  for (const c of clicks) {
    const a = t - c;
    if (a >= -0.08 && a <= 0.12) press = 0.86;
    if (a >= 0 && a <= 0.5) { rip = 1 - a / 0.5; k = a / 0.5; }
  }
  $('#cursor').style.transform = `scale(${press})`;
  const r = $('#ripple');
  r.style.left = p.x + 'px';
  r.style.top = p.y + 'px';
  r.style.opacity = rip;
  r.style.transform = `scale(${0.4 + k * 1.1})`;
}
function camera(t, frames) {
  const c = kf(t, frames);
  stage.style.transform = `translate(${innerWidth / 2 - c.x * c.z}px, ${innerHeight / 2 - c.y * c.z}px) scale(${c.z})`;
}
function caption(t, caps) {
  let text = '';
  let o = 0;
  for (const c of caps) {
    if (t >= c.at && t < c.to) {
      text = c.text;
      o = Math.min(prog(t, c.at, c.at + 0.3), 1 - prog(t, c.to - 0.3, c.to));
    }
  }
  const span = $('#caption span');
  span.textContent = text;
  $('#caption').style.opacity = text ? o : 0;
  $('#caption').style.transform = `translateY(${(1 - o) * 10}px)`;
}

// whole desktop view and the pill area, in stage coordinates
// 16:10 (README) shows the whole stage; 16:9 (YouTube) keeps the menu bar and crops the bottom.
const WIDE = innerWidth / innerHeight > 1.7;
const FULL = WIDE ? { x: 800, y: 450, z: 0.8 } : { x: 800, y: 500, z: 0.8 };
const PILL = { x: 800, y: 140, z: 1.45 };

// ---------- clips ----------
const CLIPS = {
  hero: {
    duration: 7.4,
    build() {
      menubar('Chrome');
      browser();
      vscode([], [], '');
      // lower, so the tab strip stays visible under the pills that are still waiting
      $('#vscode').style.top = '230px';
      $('#vscode').style.height = '740px';
      overlays();
    },
    render(t) {
      const clickAt = 4.2;
      const sw = clickAt + 0.1;
      $('#browser').style.opacity = 1 - eprog(t, sw, sw + 0.35);
      $('#vscode').style.opacity = eprog(t, sw, sw + 0.35);
      menubarApp(t < sw + 0.2 ? 'Chrome' : 'Code');
      const pills = [
        { state: 'done', name: 'checkout-refactor', text: 'Validation added · all 3 tests pass', at: 0.3 },
        { state: 'review', name: 'landing-page', text: 'Plan ready · pricing section in 3 steps', at: 0.9 },
        { state: 'input', name: 'payments', text: 'Allow Bash: npm run migrate', at: 1.5, out: clickAt + 0.05 },
      ].filter((p) => t >= p.at).sort((a, b) => order(a.state) - order(b.state));
      renderPills(t, pills);
      edge(t, []);
      const waiting = pills.filter((p) => p.out === undefined || t < p.out).length;
      setIcon(waiting ? pills[0].state : null, waiting);
      const onPay = t >= sw;
      const pop = onPay && t < sw + 0.9 ? `box-shadow: inset 0 0 0 2px #FF9F0A; background:#2f2a22` : '';
      setTabs([
        { title: '🟢 checkout-refactor', on: !onPay },
        { title: '🟣 landing-page' },
        { title: '🟠 payments', on: onPay, style: pop },
        { title: '✳ docs-update' },
      ]);
      setSessions([
        { name: 'payments', state: 'input', on: onPay },
        { name: 'landing-page', state: 'review' },
        { name: 'checkout-refactor', state: 'done' },
        { name: 'docs-update', state: 'idle' },
      ]);
      $('#term').innerHTML = `<div class="c1">✻ Claude Code</div><div class="c3">&gt; migrate the plans table</div><br><div class="c2">● Bash(npm run migrate)</div>
        <div style="margin-top:14px;border:1px solid #FF9F0A;border-radius:8px;padding:12px 14px;color:#fff">Allow Claude to run <b>npm run migrate</b>?<br>
        <span style="color:#FF9F0A">❯ 1. Yes</span><br>  2. No, tell Claude what to do</div>`;
      camera(t, [[0, FULL], [1.9, FULL], [2.7, { x: 800, y: 150, z: 1.45 }], [4.35, { x: 800, y: 150, z: 1.45 }], [5.1, { x: 780, y: 360, z: 1.15 }], [7.4, { x: 780, y: 360, z: 1.15 }]]);
      cursor(t, [[0, { x: 900, y: 720 }], [2.8, { x: 940, y: 520 }], [4.0, { sel: '#pills .pill .b.go', x: 1037, y: 100 }], [4.6, { sel: '#pills .pill .b.go', x: 1037, y: 100 }], [6.4, { x: 880, y: 470 }]], [clickAt]);
      caption(t, [{ at: 0.2, to: 2.6, text: 'Three sessions want you. Most urgent first.' }, { at: 2.7, to: 4.3, text: 'Go to the one that needs you.' }, { at: 4.6, to: 7.4, text: 'You land on its exact terminal tab.' }]);
    },
  },

  menubar: {
    duration: 6.4,
    build() {
      menubar('Chrome');
      browser();
      vscode([], [], '');
      overlays();
      add(stage, listHTML());
    },
    render(t) {
      const iconAt = 0.95, rowAt = 2.3, goAt = 3.7;
      const sw = goAt + 0.1;
      $('#browser').style.opacity = 1 - eprog(t, sw, sw + 0.35);
      $('#vscode').style.opacity = eprog(t, sw, sw + 0.35);
      menubarApp(t < sw + 0.2 ? 'Chrome' : 'Code');
      setIcon(t < goAt ? 'input' : 'review', t < goAt ? 3 : 2);
      renderPills(-1, []);
      edge(t, []);
      const L = $('#list');
      const lk = spring(prog(t, iconAt + 0.05, iconAt + 0.55));
      const closing = 1 - eprog(t, goAt + 0.05, goAt + 0.3);
      L.style.opacity = t >= iconAt ? clamp(lk * 1.4) * closing : 0;
      L.style.transform = `scale(${0.94 + 0.06 * lk})`;
      const openK = eprog(t, rowAt, rowAt + 0.35);
      $('#row0').style.borderColor = `rgba(255,159,10,${openK})`;
      $('#row0').style.background = `rgba(${Math.round(lerp(40, 5, openK))},${Math.round(lerp(40, 5, openK))},${Math.round(lerp(44, 6, openK))},1)`;
      $('#row0 .a').style.display = openK > 0.5 ? 'none' : '';
      $('#row0 .btns').style.display = openK > 0.5 ? 'flex' : 'none';
      $('#row0 .more').style.maxHeight = openK * 20 + 'px';
      const onPay = t >= sw;
      setTabs([
        { title: '🟢 checkout-refactor', on: !onPay },
        { title: '🟣 landing-page' },
        { title: '🟠 payments', on: onPay, style: onPay && t < sw + 0.9 ? 'box-shadow: inset 0 0 0 2px #FF9F0A; background:#2f2a22' : '' },
      ]);
      setSessions([{ name: 'payments', state: 'input', on: onPay }, { name: 'landing-page', state: 'review' }, { name: 'checkout-refactor', state: 'done' }]);
      $('#term').innerHTML = `<div class="c1">✻ Claude Code</div><div class="c3">&gt; migrate the plans table</div><br><div class="c2">● Bash(npm run migrate)</div>
        <div style="margin-top:14px;border:1px solid #FF9F0A;border-radius:8px;padding:12px 14px;color:#fff">Allow Claude to run <b>npm run migrate</b>?<br>
        <span style="color:#FF9F0A">❯ 1. Yes</span><br>  2. No, tell Claude what to do</div>`;
      camera(t, [[0, FULL], [0.6, { x: 1260, y: 210, z: 1.5 }], [3.85, { x: 1260, y: 210, z: 1.5 }], [4.6, { x: 760, y: 300, z: 1.2 }], [6.4, { x: 760, y: 300, z: 1.2 }]]);
      cursor(t, [[0, { x: 1000, y: 600 }], [0.8, { sel: '#mbicon', x: 1480, y: 17 }], [1.4, { sel: '#mbicon', x: 1480, y: 17 }], [2.1, { sel: '#row0 .n', x: 1220, y: 120 }], [2.55, { sel: '#row0 .n', x: 1220, y: 120 }],
        [3.5, { sel: '#row0 .btns > span:last-child', x: 1514, y: 128 }], [4.0, { sel: '#row0 .btns > span:last-child', x: 1514, y: 128 }], [5.4, { x: 900, y: 480 }]], [iconAt, rowAt, goAt]);
      caption(t, [{ at: 0.2, to: 2.2, text: 'Click the icon: everything waiting, most urgent first.' }, { at: 2.3, to: 3.65, text: 'Open one to see more and act on it.' }, { at: 3.9, to: 6.4, text: 'Or go straight to its terminal tab.' }]);
    },
  },

  tabs: {
    duration: 6.6,
    build() {
      menubar('Code');
      vscode([], [], `<div class="c1">✻ Claude Code</div><div class="c3">&gt; add a footer to src/index.html</div><br><div class="c2">● Read(src/index.html)</div><div class="c3">  ⎿ 12 lines</div><div class="prompt">&gt; <span class="caret"></span></div>`);
      overlays();
    },
    render(t) {
      menubarApp('Code');
      const sp = spinner(t);
      const st = (a, s) => (t >= a ? s : 'working');
      const s1 = t >= 5.0 ? 'idle' : st(1.2, 'done');
      const s2 = st(2.2, 'review');
      const s3 = st(3.2, 'input');
      const title = (s, n) => (s === 'working' ? `${sp} ${n}` : s === 'idle' ? `✳ ${n}` : `${DOT[s]} ${n}`);
      const pop = (a) => (t >= a && t < a + 0.4 ? `transform:scale(${1 + 0.08 * Math.sin(prog(t, a, a + 0.4) * Math.PI)});background:#2f2f33` : '');
      setTabs([
        { title: title(s1, 'checkout-refactor'), on: t >= 5.0, style: pop(1.2) },
        { title: title(s2, 'landing-page'), style: pop(2.2) },
        { title: title(s3, 'payments'), style: pop(3.2), on: t < 5.0 },
        { title: `✳ docs-update` },
      ]);
      setSessions([
        { name: 'payments', state: s3 === 'working' ? 'working' : 'input' },
        { name: 'landing-page', state: s2 },
        { name: 'checkout-refactor', state: s1 },
        { name: 'docs-update', state: 'idle' },
      ]);
      $('#sbcount').textContent = ['', '● 1 Claude', '● 2 Claude', '● 3 Claude'][[1.2, 2.2, 3.2].filter((a) => t >= a).length];
      camera(t, [[0, { x: 760, y: 420, z: 0.95 }], [0.9, { x: 600, y: 230, z: 1.4 }], [6.6, { x: 600, y: 230, z: 1.4 }]]);
      cursor(t, [[0, { x: 900, y: 700 }], [4.2, { x: 700, y: 420 }], [4.85, { sel: '.vtab:nth-child(1)', x: 560, y: 158 }], [6.6, { sel: '.vtab:nth-child(1)', x: 560, y: 158 }]], [5.0]);
      caption(t, [{ at: 0.3, to: 4.4, text: 'Every tab shows who is waiting.' }, { at: 4.6, to: 6.6, text: 'Looked at it? Back to normal.' }]);
    },
  },

  sessions: {
    duration: 6.6,
    build() {
      menubar('Code');
      vscode([], [], '');
      overlays();
    },
    render(t) {
      menubarApp('Code');
      const sp = spinner(t);
      const clickAt = 4.4;
      const list = [
        { name: 'payments', state: t >= 2.0 ? 'input' : 'working', since: 2.0 },
        { name: 'landing-page', state: t >= 2.9 ? 'review' : 'working', since: 2.9 },
        { name: 'checkout-refactor', state: t >= 1.1 ? 'done' : 'working', since: 1.1 },
        { name: 'release-notes', state: 'working', since: 0 },
        { name: 'docs-update', state: 'idle', since: 0 },
      ].sort((a, b) => order2(a.state) - order2(b.state));
      const detail = { input: 'Allow Bash: npm run migrate', review: 'Plan ready · 3 steps', done: 'All 3 tests pass', working: 'Working…', idle: '' };
      setSessions(list.map((x) => ({ name: x.name, state: x.state, on: t >= clickAt && x.name === 'payments',
        label: `${LABEL[x.state] || x.state} · ${t - x.since < 1 || x.since === 0 ? 'now' : 'now'}${detail[x.state] ? ' · ' + detail[x.state] : ''}` })));
      const title = (st, n) => (st === 'working' ? `${sp} ${n}` : st === 'idle' ? `✳ ${n}` : `${DOT[st]} ${n}`);
      const S = Object.fromEntries(list.map((x) => [x.name, x.state]));
      const onPay = t >= clickAt;
      setTabs([
        { title: title(S['release-notes'], 'release-notes'), on: !onPay },
        { title: title(S['checkout-refactor'], 'checkout-refactor') },
        { title: title(onPay ? 'input' : S.payments, 'payments'), on: onPay },
        { title: title(S['landing-page'], 'landing-page') },
      ]);
      $('#term').innerHTML = onPay
        ? `<div class="c1">✻ Claude Code</div><div class="c3">&gt; migrate the plans table</div><br><div class="c2">● Bash(npm run migrate)</div>
           <div style="margin-top:14px;border:1px solid #FF9F0A;border-radius:8px;padding:12px 14px;color:#fff">Allow Claude to run <b>npm run migrate</b>?<br>
           <span style="color:#FF9F0A">❯ 1. Yes</span><br>  2. No, tell Claude what to do</div>`
        : `<div class="c1">✻ Claude Code</div><div class="c3">&gt; write the release notes</div><br><div class="c2">● Read(CHANGELOG.md)</div><div class="c3">  ⎿ ${sp} Working…</div>`;
      const waiting = list.filter((x) => ['input', 'review', 'done', 'error'].includes(x.state)).length;
      $('#sbcount').textContent = waiting ? `● ${waiting} Claude` : '';
      camera(t, [[0, { x: 760, y: 440, z: 0.95 }], [0.9, { x: 430, y: 380, z: 1.5 }], [4.0, { x: 430, y: 380, z: 1.5 }], [4.9, { x: 720, y: 330, z: 1.15 }], [6.6, { x: 720, y: 330, z: 1.15 }]]);
      cursor(t, [[0, { x: 640, y: 700 }], [3.2, { x: 420, y: 520 }], [4.15, { sel: '#sess .srow:nth-child(1) .n', x: 260, y: 345 }], [6.6, { sel: '#sess .srow:nth-child(1) .n', x: 260, y: 345 }]], [clickAt]);
      caption(t, [{ at: 0.2, to: 4.2, text: 'Every session, live, in the sidebar.' }, { at: 4.4, to: 6.6, text: 'Click one, and you are there.' }]);
    },
  },

  snooze: {
    duration: 7.4,
    build() { menubar('Chrome'); browser(); overlays(); add(stage, `<div id="lock"><div class="time">9:41</div><div class="date">Wednesday, 21 October</div></div>`); },
    render(t) {
      menubarApp('Chrome');
      const clickAt = 2.3;
      const lockIn = 3.4, lockOut = 4.9;
      const back = 5.1;
      renderPills(t, [
        { state: 'done', name: 'checkout-refactor', text: 'Validation added · all 3 tests pass', at: 0.4, out: clickAt + 0.05, fly: { x: 330, y: -80 } },
        { state: 'input', name: 'payments', text: 'Allow Bash: npm run migrate', at: back + 0.15 },
        { state: 'review', name: 'landing-page', text: 'Plan ready · pricing section in 3 steps', at: back + 0.3 },
      ], { at: back, text: 'While you were away · 2' });
      edge(t, []);
      setIcon(t >= 0.4 && t < back ? 'done' : t >= back ? 'input' : null, t >= back ? 3 : t >= 0.4 ? 1 : 0);
      const lk = Math.min(eprog(t, lockIn, lockIn + 0.4), 1 - eprog(t, lockOut, lockOut + 0.35));
      $('#lock').style.opacity = lk;
      camera(t, [[0, FULL], [0.9, PILL], [2.6, PILL], [3.2, FULL], [5.0, FULL], [5.7, { x: 800, y: 160, z: 1.35 }], [7.4, { x: 800, y: 160, z: 1.35 }]]);
      cursor(t, [[0, { x: 820, y: 700 }], [1.6, { x: 900, y: 420 }], [2.2, { sel: '#pills .pill .b:nth-child(2)', x: 906, y: 100 }], [2.7, { sel: '#pills .pill .b:nth-child(2)', x: 906, y: 100 }], [3.3, { x: 980, y: 520 }]], [clickAt]);
      $('#cursor').style.opacity = t > lockIn && t < lockOut + 0.4 ? 0 : 1;
      caption(t, [{ at: 0.3, to: 3.0, text: 'Not now? Snooze it for 5 minutes.' }, { at: 3.3, to: 5.0, text: 'You step away…' }, { at: 5.1, to: 7.4, text: '…nothing gets lost.' }]);
    },
  },

  mac: {
    duration: 6.8,
    build() { menubar('TextEdit'); editor(); overlays(); },
    render(t) {
      menubarApp('TextEdit');
      const freeAt = 4.6;
      const text = 'Release notes 2.4.2\n\n· Clear errors for bad quantities\n· New pricing section\n· Faster database migrations';
      const n = Math.floor(clamp(prog(t, 0.9, 4.2)) * text.length);
      $('#doc').textContent = text.slice(0, n) + (t < freeAt ? '▍' : '');
      $('#ring').style.opacity = Math.min(eprog(t, 0.35, 0.6), 1 - eprog(t, freeAt, freeAt + 0.25));
      renderPills(t, [
        { state: 'mac', name: 'release-notes', text: 'Claude is typing in TextEdit', at: 0.35, out: 2.0 },
        { state: 'free', name: 'release-notes', text: 'You can use your Mac again', at: freeAt + 0.1, out: 6.5 },
      ]);
      edge(t, [{ state: 'free', at: freeAt }]);
      setIcon(t >= 0.35 && t < freeAt ? 'mac' : null, 0);
      camera(t, [[0, FULL], [6.8, FULL]]); // the whole screen, so the red ring is always visible
      $('#cursor').style.opacity = 0;
      caption(t, [{ at: 0.3, to: 4.5, text: 'Claude is using your Mac: the red ring says hands off.' }, { at: 4.7, to: 6.8, text: 'Green means it is yours again.' }]);
    },
  },

  talk: {
    duration: 8.2,
    build() {
      menubar('Code');
      browser();
      vscode([], [], '');
      overlays();
    },
    render(t) {
      const toWeb = 4.2;
      $('#browser').style.opacity = eprog(t, toWeb, toWeb + 0.35);
      $('#vscode').style.opacity = 1 - eprog(t, toWeb, toWeb + 0.35);
      menubarApp(t < toWeb + 0.2 ? 'Code' : 'Chrome');
      const prompt = 'rename this tab to release-checklist, and ping me if you need my password';
      const n = Math.floor(clamp(prog(t, 0.3, 1.9)) * prompt.length);
      const renamed = t >= 2.7;
      let term = `<div class="c1">✻ Claude Code</div><div style="color:#fff">&gt; ${prompt.slice(0, n)}${t < 2.0 ? '<span class="caret"></span>' : ''}</div>`;
      if (t >= 2.3) term += `<br><div class="c2">● Bash(cca rename "release-checklist")</div>`;
      if (t >= 2.7) term += `<div class="c3">  ⎿ Renamed</div>`;
      if (t >= 3.1) term += `<div class="c2">● Bash(./release.sh)</div><div class="c3">  ⎿ Waiting for the keychain…</div>`;
      $('#term').innerHTML = term;
      const sp = spinner(t);
      setTabs([{ title: t < 2.0 ? '✳ claude' : renamed ? `${sp} release-checklist` : `${sp} claude`, on: true, style: t >= 2.7 && t < 3.1 ? 'background:#2f2f33' : '' }, { title: '✳ landing-page' }]);
      setSessions([{ name: renamed ? 'release-checklist' : 'claude', state: t >= 5.0 ? 'input' : 'working' }, { name: 'landing-page', state: 'idle' }]);
      renderPills(t, [{ state: 'input', name: 'release-checklist', text: 'Enter your Mac password in the keychain prompt', at: 5.0 }]);
      edge(t, []);
      setIcon(t >= 5.0 ? 'input' : null, t >= 5.0 ? 1 : 0);
      camera(t, [[0, { x: 620, y: 260, z: 1.35 }], [3.9, { x: 620, y: 260, z: 1.35 }], [4.5, FULL], [5.3, FULL], [6.1, PILL], [8.2, PILL]]);
      $('#cursor').style.opacity = 0;
      caption(t, [{ at: 0.2, to: 2.6, text: 'Just ask Claude.' }, { at: 2.7, to: 4.2, text: 'It renames its own tab…' }, { at: 4.9, to: 8.2, text: '…and pings you when it needs you.' }]);
    },
  },

  intro: {
    duration: 3.2,
    build() {
      add(document.body, `<div id="brand" style="position:absolute;inset:0;z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 20%,#F6E7D8,#EBD5C3 55%,#D9B9A3)">
        <div class="g" style="display:grid;grid-template-columns:34px 34px;gap:8px;margin-bottom:34px"><i style="width:34px;height:34px;border-radius:9px;background:#34C759;display:block"></i><i style="width:34px;height:34px;border-radius:9px;background:#FF9F0A;display:block"></i><i style="width:34px;height:34px;border-radius:9px;background:#BF5AF2;display:block"></i><i style="width:34px;height:34px;border-radius:9px;background:#4C8DFF;display:block"></i></div>
        <div class="h" style="font:500 76px/1.05 'NY',ui-serif,Georgia,serif;color:#1f1e1d;letter-spacing:-1.5px">Claude Code Alerts</div>
        <div class="s" style="font:500 26px/1.4 var(--sans);color:#6b6964;margin-top:20px">Know which Claude Code agent is done, or needs you.</div></div>`);
    },
    render(t) {
      const b = $('#brand');
      b.style.opacity = 1 - eprog(t, 2.7, 3.2);
      $('#brand .g').style.transform = `scale(${0.6 + 0.4 * spring(prog(t, 0.05, 0.8))})`;
      $('#brand .h').style.opacity = eprog(t, 0.25, 0.7);
      $('#brand .h').style.transform = `translateY(${(1 - out(prog(t, 0.25, 0.9))) * 18}px)`;
      $('#brand .s').style.opacity = eprog(t, 0.6, 1.1);
    },
  },

  outro: {
    duration: 5.0,
    build() {
      add(document.body, `<div id="brand" style="position:absolute;inset:0;z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 20%,#F6E7D8,#EBD5C3 55%,#D9B9A3)">
        <div class="k" style="font:600 16px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:#d97757;margin-bottom:18px">Free · open source · macOS</div>
        <div class="h" style="font:500 64px/1.05 'NY',ui-serif,Georgia,serif;color:#1f1e1d;letter-spacing:-1px">Claude Code Alerts</div>
        <div class="c" style="margin-top:34px;font:500 19px/1 'SF Mono',ui-monospace,Menlo,monospace;color:#f2efe8;background:#1f1e1d;padding:18px 26px;border-radius:14px">curl -fsSL https://raw.githubusercontent.com/LucaL1fe/claude-code-alerts/main/install.sh | bash</div>
        <div class="u" style="margin-top:26px;font:600 24px/1 var(--sans);color:#1f1e1d">github.com/LucaL1fe/claude-code-alerts</div></div>`);
    },
    render(t) {
      for (const [sel, a] of [['.k', 0.1], ['.h', 0.3], ['.c', 0.7], ['.u', 1.1]]) {
        const e = $('#brand ' + sel);
        e.style.opacity = eprog(t, a, a + 0.45);
        e.style.transform = `translateY(${(1 - out(prog(t, a, a + 0.6))) * 16}px)`;
      }
    },
  },

  end: {
    duration: 4.6,
    build() {
      const gh = '<svg viewBox="0 0 16 16" width="44" height="44" aria-hidden="true"><path fill="#1f1e1d" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
      add(document.body, `<div id="brand" style="position:absolute;inset:0;z-index:400;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(120% 90% at 50% 20%,#F6E7D8,#EBD5C3 55%,#D9B9A3)">
        <div class="h" style="font:500 92px/1 'NY',ui-serif,Georgia,serif;color:#1f1e1d;letter-spacing:-2px">Free &amp; open source</div>
        <div class="u" style="margin-top:44px;display:flex;align-items:center;gap:18px;background:#fffaf3;border-radius:20px;padding:20px 30px;box-shadow:0 18px 50px rgba(60,35,20,.18)">${gh}
          <span style="font:650 34px/1 var(--sans);color:#1f1e1d;letter-spacing:-.3px">github.com/LucaL1fe/claude-code-alerts</span></div>
        <div class="s" style="margin-top:30px;font:500 22px/1.4 var(--sans);color:#6b6964">MIT licensed · Star it, try it, build it with us.</div></div>`);
    },
    render(t) {
      for (const [sel, a] of [['.h', 0.1], ['.u', 0.45], ['.s', 0.85]]) {
        const e = $('#brand ' + sel);
        e.style.opacity = eprog(t, a, a + 0.45);
        e.style.transform = `translateY(${(1 - out(prog(t, a, a + 0.6))) * 16}px)` + (sel === '.u' ? ` scale(${0.96 + 0.04 * spring(prog(t, a, a + 0.8))})` : '');
      }
    },
  },

  thumb: {
    duration: 0,
    build() {
      menubar('Chrome');
      browser();
      overlays();
      add(document.body, `<div style="position:absolute;left:0;right:0;bottom:0;height:300px;z-index:399;background:linear-gradient(to bottom, rgba(240,238,230,0), #F0EEE6 38%)"></div>`);
      add(document.body, `<div id="thumbtext" style="position:absolute;left:0;right:0;bottom:40px;z-index:400;text-align:center">
        <div style="display:inline-block;font:800 26px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:#fff;background:#d97757;padding:9px 16px;border-radius:9px;margin-bottom:14px">Claude Code</div>
        <div style="font:850 100px/0.98 var(--sans);letter-spacing:-3px;color:#14130f">Which agent is done?</div></div>`);
    },
    render() {
      menubarApp('Chrome');
      renderPills(9, [
        { state: 'input', name: 'payments', text: 'Allow Bash: npm run migrate', at: 0 },
        { state: 'review', name: 'landing-page', text: 'Plan ready · pricing section in 3 steps', at: 0 },
        { state: 'done', name: 'checkout-refactor', text: 'Validation added · all 3 tests pass', at: 0 },
      ]);
      edge(9, []);
      setIcon('input', 3);
      camera(9, [[0, { x: 800, y: 360 / 1.72, z: 1.72 }]]);
      $('#cursor').style.opacity = 0;
      $('#browser').style.filter = 'blur(2px)';
    },
  },
};

function order(s) { return { input: 0, review: 1, error: 2, done: 3 }[s] ?? 9; }
function order2(s) { return { input: 0, review: 1, error: 2, done: 3, mac: 4, working: 5, idle: 6 }[s] ?? 9; }
function menubarApp(name) { $('#menubar .left b:nth-child(2)').textContent = name; }
function listHTML() {
  const row = (id, state, name, text, ago) => `<div class="lrow" id="${id}" style="border:1.5px solid transparent">
    <span class="d" style="background:${COL[state]}"></span><span class="t"><div class="n">${name} <span style="opacity:.45;font-size:11px">✎</span></div>
    <div class="x" style="color:${COL[state]}">${text}</div><div class="more" style="max-height:0;overflow:hidden;font:500 11.5px/18px var(--sans);color:rgba(255,255,255,.45)">just now · ${LABEL[state]}</div></span>
    <span class="a">${ago}</span><span class="btns" style="display:none;gap:6px">${['x', 'clock', 'check'].map((k) => `<span class="b" style="width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round">${ICON[k]}</svg></span>`).join('')}<span class="b" style="width:28px;height:28px;border-radius:50%;background:${COL[state]};display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:#000;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round">${ICON.go}</svg></span></span></div>`;
  return `<div id="list"><div class="hd"><span>Waiting for you · 3</span><span>Mute all</span></div>
    ${row('row0', 'input', 'payments', 'Allow Bash: npm run migrate', 'now')}
    ${row('row1', 'review', 'landing-page', 'Plan ready · pricing section in 3 steps', 'now')}
    ${row('row2', 'done', 'checkout-refactor', 'Validation added · all 3 tests pass', 'now')}</div>`;
}

const TITLES = {"hero": {"label": "Alerts", "head": "Know the moment a session needs you", "sub": "Pills name the session, most urgent first. One click takes you to its terminal tab."}, "menubar": {"label": "Menu bar list", "head": "Everything waiting, in one list", "sub": "Click the menu bar icon: all alerts by urgency. Open one, act on it, or go there."}, "tabs": {"label": "Tab dots", "head": "Your tabs show who is waiting", "sub": "🟢 done · 🟠 needs you · 🟣 plan ready · 🔴 error"}, "sessions": {"label": "Claude Sessions view", "head": "Every session at a glance", "sub": "Live state of all your Claude sessions, right in VS Code."}, "snooze": {"label": "Snooze & away", "head": "Snooze it. Step away. Nothing gets lost.", "sub": "Later brings it back in 5 minutes. Away? One summary when you return."}, "mac": {"label": "Computer use", "head": "See when Claude uses your Mac", "sub": "A red ring while it drives, a green glow when it is yours again."}, "talk": {"label": "Ask Claude", "head": "Just ask Claude", "sub": "It renames its own tab and pings you when it needs you."}};
const clipName = new URLSearchParams(location.search).get('clip') || 'hero';
const clip = CLIPS[clipName];
clip.build();
window.DURATION = clip.duration + 1.2;
// Title card for the first 1.3 s, then the feature label stays in the corner.
const T = TITLES[clipName];
if (!T) {
  // intro, outro and the thumbnail have no feature card
  $('#titlecard').style.display = 'none';
  $('#label').style.display = 'none';
  $('#caption').style.display = 'none';
  window.DURATION = clip.duration;
  window.render = (t) => clip.render(t);
} else {
$('#titlecard .k').textContent = 'Claude Code Alerts';
$('#titlecard .h').textContent = T.head;
$('#titlecard .s').textContent = T.sub;
$('#label b').textContent = '· ' + T.label;
window.render = (t) => {
  clip.render(Math.max(0, t - 1.2));
  const card = 1 - eprog(t, 1.15, 1.55);
  $('#titlecard').style.opacity = card;
  $('#titlecard .h').style.transform = `translateY(${(1 - out(clamp(t / 0.6))) * 14}px)`;
  $('#label').style.opacity = eprog(t, 1.35, 1.7);
};
}
window.render(0);
