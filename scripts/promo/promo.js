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
    <div class="titlebar"><div class="dots"><i></i><i></i><i></i></div><div class="tab">r/ProgrammerHumor</div></div>
    <div class="url"><span>reddit.com/r/ProgrammerHumor</span></div>
    <div class="feed">
      <div class="banner"></div>
      <div class="sub"><div class="logo">&lt;/&gt;</div><h1>r/ProgrammerHumor</h1></div>
      <div class="post"><div class="meta">u/compiles_first_try · 3h</div><h2>Me waiting for Claude to finish</h2>
        <div class="meme"><div class="top">Claude: "I'll just run the tests"</div>
          <div class="pic"><div>Me, checking the terminal every 30 seconds</div><div>Me, with Claude Code Alerts</div></div></div></div>
      <div class="side"><b>r/ProgrammerHumor</b><br>For anything funny related to programming and software development.</div>
    </div></div>`);
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
  $('#sess').innerHTML = list.map((s) => `<div class="srow"><span class="d" style="background:${COL[s.state]}"></span><span class="n">${s.name}</span><span class="s">${s.label || LABEL[s.state] || s.state}</span></div>`).join('');
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
function cursor(t, path, clicks = []) {
  const p = kf(t, path);
  $('#cursor').style.left = p.x + 'px';
  $('#cursor').style.top = p.y + 'px';
  let press = 1;
  let rip = 0;
  let rp = null;
  for (const c of clicks) {
    const a = t - c;
    if (a >= -0.08 && a <= 0.12) press = 0.86;
    if (a >= 0 && a <= 0.5) { rip = 1 - a / 0.5; rp = { k: a / 0.5 }; }
  }
  $('#cursor').style.transform = `scale(${press})`;
  const r = $('#ripple');
  r.style.left = p.x + 3 + 'px';
  r.style.top = p.y + 3 + 'px';
  r.style.opacity = rip;
  r.style.transform = rp ? `scale(${0.4 + rp.k * 1.1})` : 'scale(0.4)';
}
function camera(t, frames) {
  const c = kf(t, frames);
  stage.style.transform = `translate(${640 - c.x * c.z}px, ${400 - c.y * c.z}px) scale(${c.z})`;
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
const FULL = { x: 800, y: 500, z: 0.8 };
const PILL = { x: 800, y: 110, z: 1.65 };

// ---------- clips ----------
const CLIPS = {
  hero: {
    duration: 7.6,
    build() {
      menubar('Chrome');
      browser();
      vscode(
        [{ title: '✳ landing-page' }, { title: '✳ checkout-refactor' }, { title: '✳ payments' }],
        [{ name: 'checkout-refactor', state: 'idle', label: 'idle · now' }, { name: 'landing-page', state: 'working' }, { name: 'payments', state: 'working' }],
        `<div class="c1">✻ Claude Code</div><div class="c3">&gt; make total() reject bad input and add tests</div><br>
         <div class="c2">● Update(src/cart.js)</div><div class="c3">  ⎿ Added 6 lines</div><div class="c2">● Bash(node --test)</div>
         <div class="ok">  ⎿ ✓ 3 tests pass</div><br><div>Validation added, all 3 tests pass.</div><div class="prompt">&gt; <span class="caret"></span></div>`);
      overlays();
    },
    render(t) {
      const sw = 3.75; // the click on →
      $('#browser').style.opacity = 1 - eprog(t, sw + 0.05, sw + 0.4);
      $('#vscode').style.opacity = eprog(t, sw + 0.05, sw + 0.4);
      menubarApp(t < sw + 0.2 ? 'Chrome' : 'Code');
      setIcon(t >= 1.0 && t < sw ? 'done' : null, t >= 1.0 && t < sw ? 1 : 0);
      renderPills(t, [{ state: 'done', name: 'checkout-refactor', text: 'Validation added · all 3 tests pass', at: 1.0, out: sw + 0.05 }]);
      edge(t, [{ state: 'done', at: 1.0 }]);
      const sp = spinner(t);
      setTabs([
        { title: `${sp} landing-page` },
        { title: t < sw + 0.3 ? '🟢 checkout-refactor' : '✳ checkout-refactor', on: t >= sw + 0.3 },
        { title: `${sp} payments` },
      ]);
      camera(t, [[0, FULL], [1.35, FULL], [2.3, PILL], [3.2, { x: 940, y: 112, z: 1.8 }], [3.8, { x: 940, y: 112, z: 1.8 }], [4.6, FULL], [5.6, FULL], [6.5, { x: 640, y: 160, z: 1.7 }], [7.6, { x: 640, y: 160, z: 1.7 }]]);
      cursor(t, [[0, { x: 900, y: 720 }], [2.4, { x: 940, y: 520 }], [3.55, { x: 1037, y: 100 }], [4.4, { x: 1037, y: 100 }], [6.4, { x: 560, y: 150 }]], [sw]);
      caption(t, [{ at: 0.1, to: 2.2, text: 'Four Claude sessions. You are on Reddit.' }, { at: 2.2, to: 4.3, text: 'The second one is done, you know it.' }, { at: 4.6, to: 7.6, text: 'One click: the exact terminal tab.' }]);
    },
  },

  several: {
    duration: 7.2,
    build() { menubar('Chrome'); browser(); overlays(); add(stage, listHTML()); },
    render(t) {
      menubarApp('Chrome');
      const listAt = 3.55;
      const pills = [
        { state: 'done', name: 'checkout-refactor', text: 'Validation added · all 3 tests pass', at: 0.5 },
        { state: 'review', name: 'landing-page', text: 'Plan ready · pricing section in 3 steps', at: 1.05 },
        { state: 'input', name: 'payments', text: 'Allow Bash: npm run migrate', at: 1.6 },
      ];
      const shown = pills.filter((p) => t >= p.at).sort((a, b) => order(a.state) - order(b.state));
      renderPills(t < listAt ? t : -1, shown);
      edge(t, [{ state: 'done', at: 0.5 }, { state: 'review', at: 1.05 }, { state: 'input', at: 1.6 }]);
      const n = shown.length;
      setIcon(n ? shown[0].state : null, n);
      const lk = spring(prog(t, listAt, listAt + 0.5));
      const L = $('#list');
      L.style.opacity = t >= listAt ? clamp(lk * 1.4) : 0;
      L.style.transform = `scale(${0.94 + 0.06 * lk})`;
      // the first row opens like a pill
      const openK = eprog(t, 4.9, 5.3);
      $('#row0').style.borderColor = `rgba(255,159,10,${openK})`;
      $('#row0').style.background = `rgba(${Math.round(lerp(40, 5, openK))},${Math.round(lerp(40, 5, openK))},${Math.round(lerp(44, 6, openK))},1)`;
      $('#row0 .a').style.display = openK > 0.5 ? 'none' : '';
      $('#row0 .btns').style.display = openK > 0.5 ? 'flex' : 'none';
      $('#row0 .more').style.maxHeight = openK * 20 + 'px';
      camera(t, [[0, FULL], [1.9, FULL], [2.6, PILL], [3.3, { x: 1190, y: 60, z: 1.55 }], [4.3, { x: 1260, y: 200, z: 1.45 }], [7.2, { x: 1290, y: 210, z: 1.5 }]]);
      cursor(t, [[0, { x: 760, y: 760 }], [2.7, { x: 1000, y: 420 }], [3.4, { x: 1110, y: 10 }], [4.4, { x: 1110, y: 10 }], [4.85, { x: 1260, y: 140 }], [5.9, { x: 1260, y: 140 }], [6.5, { x: 1514, y: 128 }]], [3.48, 4.9, 6.6]);
      caption(t, [{ at: 0.2, to: 3.2, text: 'Three sessions want you. Most urgent first.' }, { at: 3.4, to: 7.2, text: 'Everything waiting, in one list.' }]);
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
      camera(t, [[0, { x: 760, y: 420, z: 0.95 }], [0.9, { x: 620, y: 150, z: 1.75 }], [3.9, { x: 620, y: 150, z: 1.75 }], [4.6, { x: 560, y: 260, z: 1.25 }], [6.6, { x: 560, y: 260, z: 1.25 }]]);
      cursor(t, [[0, { x: 900, y: 700 }], [4.2, { x: 700, y: 420 }], [4.85, { x: 560, y: 158 }], [6.6, { x: 560, y: 158 }]], [5.0]);
      caption(t, [{ at: 0.3, to: 4.4, text: 'Every tab shows who is waiting.' }, { at: 4.6, to: 6.6, text: 'Looked at it? Back to normal.' }]);
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
      edge(t, [{ state: 'done', at: 0.4 }, { state: 'input', at: back + 0.15 }]);
      setIcon(t >= 0.4 && t < back ? 'done' : t >= back ? 'input' : null, t >= back ? 3 : t >= 0.4 ? 1 : 0);
      const lk = Math.min(eprog(t, lockIn, lockIn + 0.4), 1 - eprog(t, lockOut, lockOut + 0.35));
      $('#lock').style.opacity = lk;
      camera(t, [[0, FULL], [0.9, PILL], [1.5, { x: 905, y: 112, z: 1.85 }], [2.6, { x: 905, y: 112, z: 1.85 }], [3.2, FULL], [5.0, FULL], [5.8, { x: 800, y: 150, z: 1.4 }], [7.4, { x: 800, y: 150, z: 1.4 }]]);
      cursor(t, [[0, { x: 820, y: 700 }], [1.6, { x: 900, y: 420 }], [2.2, { x: 906, y: 100 }], [2.7, { x: 906, y: 100 }], [3.3, { x: 980, y: 520 }]], [clickAt]);
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
      camera(t, [[0, FULL], [0.7, { x: 800, y: 300, z: 1.15 }], [4.4, { x: 800, y: 380, z: 1.05 }], [5.0, FULL], [6.8, FULL]]);
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
      edge(t, [{ state: 'input', at: 5.0 }]);
      setIcon(t >= 5.0 ? 'input' : null, t >= 5.0 ? 1 : 0);
      camera(t, [[0, { x: 760, y: 220, z: 1.25 }], [2.4, { x: 700, y: 180, z: 1.35 }], [2.9, { x: 420, y: 130, z: 1.9 }], [3.8, { x: 420, y: 130, z: 1.9 }], [4.4, FULL], [5.3, FULL], [6.2, PILL], [8.2, { x: 800, y: 112, z: 1.75 }]]);
      $('#cursor').style.opacity = 0;
      caption(t, [{ at: 0.2, to: 2.6, text: 'Just ask Claude.' }, { at: 2.7, to: 4.2, text: 'It renames its own tab…' }, { at: 4.9, to: 8.2, text: '…and pings you when it needs you.' }]);
    },
  },
};

function order(s) { return { input: 0, review: 1, error: 2, done: 3 }[s] ?? 9; }
function menubarApp(name) { $('#menubar .left b:nth-child(2)').textContent = name; }
function listHTML() {
  const row = (id, state, name, text, ago) => `<div class="lrow" id="${id}" style="border:1.5px solid transparent">
    <span class="d" style="background:${COL[state]}"></span><span class="t"><div class="n">${name} <span style="opacity:.45;font-size:11px">✎</span></div>
    <div class="x" style="color:${COL[state]}">${text}</div><div class="more" style="max-height:0;overflow:hidden;font:500 11.5px/18px -apple-system;color:rgba(255,255,255,.45)">just now · ${LABEL[state]}</div></span>
    <span class="a">${ago}</span><span class="btns" style="display:none;gap:6px">${['x', 'clock', 'check'].map((k) => `<span class="b" style="width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round">${ICON[k]}</svg></span>`).join('')}<span class="b" style="width:28px;height:28px;border-radius:50%;background:${COL[state]};display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:#000;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round">${ICON.go}</svg></span></span></div>`;
  return `<div id="list"><div class="hd"><span>Waiting for you · 3</span><span>Mute all</span></div>
    ${row('row0', 'input', 'payments', 'Allow Bash: npm run migrate', 'now')}
    ${row('row1', 'review', 'landing-page', 'Plan ready · pricing section in 3 steps', 'now')}
    ${row('row2', 'done', 'checkout-refactor', 'Validation added · all 3 tests pass', 'now')}</div>`;
}

const clip = CLIPS[new URLSearchParams(location.search).get('clip') || 'hero'];
clip.build();
window.DURATION = clip.duration;
window.render = (t) => clip.render(t);
window.render(0);
