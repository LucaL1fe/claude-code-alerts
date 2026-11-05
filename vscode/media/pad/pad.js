// The prompt pad page: draws one level (a session, a folder or the overview) from the data the extension sends, and
// sends back what you change. The rules (what goes where, the order) are in pad/model.js, loaded before this file.
// Elements are kept by key between redraws, so the note or prompt you are typing in is never replaced under you.
(function () {
  const vscode = acquireVsCodeApi();
  const M = window.PadModel;
  const saved = vscode.getState() || {};
  const state = {
    level: saved.level || { kind: 'root' },
    fold: saved.fold || {},
    data: null,
    imageBase: '',
    features: [],
    filter: '',
    toast: null
  };
  // Your changes not yet back from the extension (id → fields), and notes or prompts made here a moment ago.
  const local = new Map();
  const saveTimers = new Map();
  const app = document.getElementById('app');
  const post = (m) => vscode.postMessage(m);
  const keep = () => vscode.setState({ level: state.level, fold: state.fold });

  const STATE_COLOR = { working: '#4c8dff', background: '#4c8dff', input: '#ff9f0a', review: '#bf5af2', done: '#34c759', error: '#ff453a', idle: '#7a7a7a', mac: '#ff453a', free: '#34c759' };
  const STATE_LABEL = { working: 'working', background: 'in background', input: 'needs you', review: 'plan ready', done: 'done', error: 'error', idle: 'idle', mac: 'using your Mac', free: 'Mac is free' };

  const svg = (d, extra = '') => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" ${extra}>${d}</svg>`;
  const I = {
    handle: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></svg>',
    right: svg('<path d="M6.5 4.5L10 8l-3.5 3.5"/>'),
    down: svg('<path d="M4.5 6.5L8 10l3.5-3.5"/>'),
    plus: svg('<path d="M8 3v10M3 8h10"/>', 'stroke-width="1.7"'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>'),
    archive: svg('<rect x="2" y="3" width="12" height="3" rx="0.5"/><path d="M3 6v7h10V6M6.5 8.5h3"/>'),
    send: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="currentColor"/></svg>',
    assign: svg('<path d="M2 8h8M7 5l3 3-3 3"/><path d="M13 3v10"/>'),
    open: svg('<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5L7.5 8.5"/><path d="M12 9.5v4H2.5V4h4"/>'),
    home: svg('<path d="M2.5 7.5L8 3l5.5 4.5"/><path d="M4 6.5v6.5h8V6.5"/>'),
    list: svg('<path d="M5 4h9M5 8h9M5 12h9"/><path d="M2 4h.5M2 8h.5M2 12h.5"/>'),
    board: svg('<rect x="2" y="3" width="3.5" height="10" rx="0.5"/><rect x="6.25" y="3" width="3.5" height="7" rx="0.5"/><rect x="10.5" y="3" width="3.5" height="5" rx="0.5"/>'),
    terminal: svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M4 6l2.5 2L4 10M8 10.5h4"/>'),
    image: svg('<rect x="2" y="3" width="12" height="10" rx="1"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>'),
    restore: svg('<path d="M4 6h6a3 3 0 0 1 0 6H6"/><path d="M6 3.5L3.5 6 6 8.5"/>'),
    unpack: svg('<path d="M8 10.5V2.5M5 5.5l3-3 3 3"/><path d="M2.5 9v4.5h11V9"/>'),
    check: svg('<path d="M3 8.5l3 3 7-7"/>'),
    x: '<svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>',
    copy: svg('<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M3 10.5V3.5a1 1 0 0 1 1-1h6.5"/>'),
    folder: svg('<path d="M1.5 4h4.5l1.2 1.3h7.3v7.2h-13z"/>'),
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>')
  };

  // ---------- elements kept by key ----------
  const cache = new Map();
  let used = new Set();

  function el(key, tag, props, kids) {
    let n = key ? cache.get(key) : null;
    if (!n || n.tagName !== tag.toUpperCase()) {
      n = document.createElement(tag);
      if (key) cache.set(key, n);
    }
    if (key) used.add(key);
    if (props) apply(n, props);
    if (kids !== undefined) setKids(n, kids);
    return n;
  }

  function apply(n, p) {
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (k === 'class') { if (n.className !== (v || '')) n.className = v || ''; }
      else if (k === 'html') { if (n._html !== v) { n.innerHTML = v; n._html = v; } }
      else if (k === 'text') { if (n.textContent !== String(v)) n.textContent = v; }
      else if (k === 'value') { if (document.activeElement !== n && n.value !== v) n.value = v; }
      else if (k === 'checked' || k === 'draggable' || k === 'disabled' || k === 'spellcheck') n[k] = !!v;
      else if (k.startsWith('on') && k in n) n[k] = v || null;
      else if (k.startsWith('on')) {
        // Events without an "on…" property (focusin, focusout): one listener per element that calls the latest handler.
        const type = k.slice(2);
        n._on = n._on || {};
        if (!(type in n._on)) n.addEventListener(type, (e) => n._on[type] && n._on[type](e));
        n._on[type] = v || null;
      }
      else if (v === null || v === undefined || v === false) n.removeAttribute(k);
      else if (n.getAttribute(k) !== String(v)) n.setAttribute(k, v);
    }
  }

  // The children in this order, moving as few as possible (a node that moves loses the focus).
  function setKids(parent, kids) {
    const want = [];
    (function add(k) {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) k.forEach(add);
      else want.push(typeof k === 'string' ? document.createTextNode(k) : k);
    })(kids);
    const wanted = new Set(want);
    for (const c of [...parent.childNodes]) if (!wanted.has(c)) parent.removeChild(c);
    for (let i = 0; i < want.length; i++) if (parent.childNodes[i] !== want[i]) parent.insertBefore(want[i], parent.childNodes[i] || null);
  }

  function btn(key, o) {
    return el(key, 'button', {
      class: 'btn' + (o.cls ? ' ' + o.cls : '') + (o.label ? '' : ' icon'), title: o.title || o.label, 'aria-label': o.title || o.label,
      type: 'button', onclick: (e) => { e.stopPropagation(); o.fn(e); }
    }, [el(key + ':i', 'span', { html: o.icon, style: 'display:flex' }), o.label ? el(key + ':l', 'span', { class: 'label', text: o.label }) : null]);
  }

  // ---------- data ----------
  function items() {
    const list = state.data.items.map((i) => (local.has(i.id) ? { ...i, ...local.get(i.id) } : i));
    for (const [id, l] of local) if (l._new && !state.data.items.some((i) => i.id === id)) list.push({ id, ...l });
    return list;
  }
  const byId = (id) => items().find((i) => i.id === id);
  const newId = () => Date.now().toString(36) + Math.random().toString(16).slice(2, 8);

  function change(id, patch, { now = false } = {}) {
    local.set(id, { ...(local.get(id) || {}), ...patch });
    clearTimeout(saveTimers.get(id));
    const send = () => {
      saveTimers.delete(id);
      const l = local.get(id);
      if (!l) return;
      const { _new, ...fields } = l;
      post({ t: 'put', id, patch: fields });
    };
    if (now) send(); else saveTimers.set(id, setTimeout(send, 350));
  }

  function create(place, kind, sectionItems, { atTop = true, status } = {}) {
    const id = newId();
    const first = sectionItems[0];
    const last = sectionItems[sectionItems.length - 1];
    const order = atTop ? M.between(null, first ? first.order : null) : M.between(last ? last.order : null, null);
    const fields = { kind, place, status: status || (kind === 'prompt' ? 'todo' : 'open'), order, created: Date.now(), text: '', draft: true };
    local.set(id, { ...fields, _new: true });
    state.fold['item:' + id] = true;
    post({ t: 'put', id, patch: fields });
    render();
    focusItem(id);
  }

  function remove(id) {
    const it = byId(id);
    if (!it) return;
    local.delete(id);
    post({ t: 'remove', id });
    const { id: _, where, ...fields } = it;
    toast('Deleted.', { label: 'Undo', fn: () => post({ t: 'put', id, patch: fields }) });
  }

  // ---------- folding ----------
  const isOpen = (key, dflt) => (key in state.fold ? state.fold[key] : dflt);
  function toggle(key, dflt) { state.fold[key] = !isOpen(key, dflt); keep(); render(); }

  // ---------- drag and drop ----------
  let drag = null;
  let dropLine = null;
  let spring = null;
  const targets = new WeakMap();

  function startDrag(e, d, rowKey) {
    drag = d;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', d.id || 'stop');
    const row = cache.get(rowKey);
    if (row) { e.dataTransfer.setDragImage(row, 12, 12); setTimeout(() => row.classList.add('dragging'), 0); }
  }
  function endDrag() {
    drag = null;
    clearSpring();
    if (dropLine) dropLine.remove();
    document.querySelectorAll('.dragging, .dropping').forEach((n) => n.classList.remove('dragging', 'dropping'));
  }
  function clearSpring() { if (spring) { clearTimeout(spring.timer); spring = null; } }
  // Hovering a closed section, session or folder while dragging opens it after a moment.
  function springOpen(key, dflt) {
    if (isOpen(key, dflt) || (spring && spring.key === key)) return;
    clearSpring();
    spring = { key, timer: setTimeout(() => { spring = null; state.fold[key] = true; keep(); render(); }, 550) };
  }

  // A list you can drop into: where in it (before which row) follows the mouse.
  function dropList(node, target) {
    targets.set(node, target);
    node.ondragover = (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = copies(target) ? 'copy' : 'move';
      const rows = [...node.children].filter((c) => c.dataset && (c.dataset.id || c.dataset.stop) && !c.classList.contains('dragging'));
      let before = null;
      for (const r of rows) { const b = r.getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { before = r; break; } }
      if (!dropLine) dropLine = Object.assign(document.createElement('div'), { className: 'drop-line' });
      node.insertBefore(dropLine, before);
      dropLine._before = before ? (before.dataset.id || 'stop') : null;
    };
    node.ondragleave = (e) => { if (dropLine && !node.contains(e.relatedTarget)) dropLine.remove(); };
    node.ondrop = (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const before = dropLine && dropLine.parentNode === node ? dropLine._before : null;
      const d = drag;
      endDrag();
      drop(d, target, before);
    };
  }

  // A closed section, a session or a folder row: drop on it = into it (prompts to its Todo, notes to its Notes).
  function dropOnto(node, foldKey, dflt, targetFor) {
    node.ondragover = (e) => {
      if (!drag || drag.type !== 'item') return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.add('dropping');
      if (foldKey) springOpen(foldKey, dflt);
    };
    node.ondragleave = (e) => { if (!node.contains(e.relatedTarget)) { node.classList.remove('dropping'); clearSpring(); } };
    node.ondrop = (e) => {
      if (!drag || drag.type !== 'item') return;
      e.preventDefault();
      e.stopPropagation();
      const d = drag;
      endDrag();
      const it = byId(d.id);
      if (it) drop(d, targetFor(it), null);
    };
  }

  // Dragging a sent prompt out of Done makes a copy: what was sent stays in Done.
  const copies = (target) => drag && drag.type === 'item' && (() => { const it = byId(drag.id); return it && it.kind === 'prompt' && M.status(it) === 'done' && target.section !== 'done'; })();

  function drop(d, target, beforeId) {
    const list = target.items().filter((i) => i.id !== d.id);
    let idx = beforeId === 'stop' ? list.findIndex((i) => (i.order || 0) >= stopOrderOf(target.place)) : beforeId ? list.findIndex((i) => i.id === beforeId) : list.length;
    if (idx < 0) idx = list.length;
    const above = list[idx - 1];
    const below = list[idx];
    const order = M.between(above ? above.order : null, below ? below.order : null);
    if (d.type === 'stop') {
      if (target.section === 'todo') post({ t: 'place', key: target.place, patch: { stopOrder: below ? order : null } });
      return;
    }
    const it = byId(d.id);
    if (!it) return;
    const patch = { place: target.place, order, archived: null, draft: null };
    const s = target.section;
    if (s === 'notes') Object.assign(patch, { kind: 'note', status: M.status(it) === 'checked' ? 'checked' : 'open' });
    else if (s === 'todo' || s === 'backlog') {
      const keepStatus = it.kind === 'prompt' && it.place === target.place && ['queued', 'failed'].includes(M.status(it));
      Object.assign(patch, { kind: 'prompt', status: keepStatus ? M.status(it) : 'todo' });
    } else if (s === 'done') Object.assign(patch, { kind: 'prompt', status: 'done', doneAt: Date.now() });
    else if (s === 'doing') Object.assign(patch, { kind: 'prompt', status: 'todo' });
    else if (s === 'archive') Object.assign(patch, { archived: true, place: it.place, order: it.order });
    if (copies(target) || (it.kind === 'prompt' && M.status(it) === 'done' && s !== 'done' && s !== 'archive')) {
      const id = newId();
      const { id: _, sentAt, doneAt, where, ...rest } = it;
      post({ t: 'put', id, patch: { ...rest, ...patch, status: patch.kind === 'note' ? 'open' : 'todo', created: Date.now(), doneAt: null } });
      if (s === 'doing') post({ t: 'send', id });
      return;
    }
    change(d.id, patch, { now: true });
    if (s === 'doing') post({ t: 'send', id: d.id });
    render();
  }

  // ---------- pasting pictures ----------
  function onPaste(e, id, ta) {
    const files = [...(e.clipboardData ? e.clipboardData.items : [])].filter((x) => x.kind === 'file' && /^image\/(png|jpe?g|gif|webp)$/.test(x.type));
    if (!files.length) return;
    e.preventDefault();
    const it = byId(id);
    let n = (it && it.images ? it.images.length : 0) + ((local.get(id) || {})._pending || 0);
    for (const f of files) {
      const file = f.getAsFile();
      if (!file) continue;
      n += 1;
      ta.focus();
      document.execCommand('insertText', false, `[Image #${n}]`);
      const r = new FileReader();
      r.onload = () => post({ t: 'image', id, data: r.result });
      r.readAsDataURL(file);
    }
    local.set(id, { ...(local.get(id) || {}), _pending: n - (it && it.images ? it.images.length : 0) });
    ta.dispatchEvent(new Event('input'));
  }

  // ---------- rows ----------
  const ago = (sec) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - (sec || 0)));
    return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
  };
  const splitPrompt = (text) => { const t = String(text || ''); const i = t.indexOf('\n'); return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).replace(/^\n/, '')]; };
  const joinPrompt = (title, desc) => (desc ? `${title}\n\n${desc}` : title);

  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  // One note or prompt. "where" says which buttons it gets.
  function row(it, where, ctx, extra = {}) {
    const key = `row:${where.key}:${it.id}`;
    const isPrompt = it.kind === 'prompt';
    const st = M.status(it);
    const open = isOpen('item:' + it.id, false);
    const cls = ['row', it.kind, isPrompt ? st : '', st === 'checked' ? 'checked' : '', it.archived ? 'archived' : ''].filter(Boolean).join(' ');
    const [title, desc] = isPrompt ? splitPrompt(it.text) : [String(it.text || '').split('\n')[0], String(it.text || '').split('\n').slice(1).join('\n')];
    // Lines below the first one (for a prompt: its description, without the blank line under the title).
    const lines = isPrompt ? (desc ? desc.split('\n').length : 0) : String(it.text || '').split('\n').length - 1;
    const images = (it.images || []).filter(Boolean);
    const kids = [];
    kids.push(el(key + ':h', 'span', {
      class: 'handle', html: I.handle, draggable: true, title: 'Drag to move',
      ondragstart: (e) => startDrag(e, { type: 'item', id: it.id }, key), ondragend: endDrag
    }));
    kids.push(el(key + ':f', 'span', { class: 'fold', html: open ? I.down : I.right, onclick: () => toggle('item:' + it.id, false) }));
    if (extra.num) kids.push(el(key + ':n', 'span', { class: 'num', text: String(extra.num) }));
    if (!isPrompt && !it.archived && where.type !== 'deleted') {
      kids.push(el(key + ':c', 'span', { class: 'check' }, [el(key + ':cb', 'input', {
        type: 'checkbox', checked: st === 'checked', title: st === 'checked' ? 'Not done' : 'Done', 'aria-label': 'Tick off',
        onchange: (e) => change(it.id, { status: e.target.checked ? 'checked' : 'open' }, { now: true })
      })]));
    }
    const body = [];
    if (!open) {
      const more = (lines > 0 ? `+${lines} line${lines === 1 ? '' : 's'}` : '') + (images.length ? `${lines > 0 ? ' · ' : ''}${images.length} image${images.length === 1 ? '' : 's'}` : '');
      body.push(el(key + ':line', 'div', { class: 'line', onclick: () => { state.fold['item:' + it.id] = true; keep(); render(); focusItem(it.id); } }, [
        title ? el(key + ':t', 'span', { class: isPrompt ? 't' : '', text: title }) : el(key + ':ph', 'span', { class: 'placeholder', text: isPrompt ? 'Title' : 'Note' }),
        more ? el(key + ':m', 'span', { class: 'more', text: more }) : null
      ]));
    } else if (isPrompt) {
      const t = el(key + ':ti', 'textarea', {
        class: 'title', rows: 1, placeholder: 'Title', spellcheck: false, value: title, 'data-item': it.id,
        oninput: (e) => { autosize(e.target); change(it.id, { text: joinPrompt(e.target.value.replace(/\n/g, ' '), cache.get(key + ':de') ? cache.get(key + ':de').value : desc) }); },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const d = cache.get(key + ':de'); if (d) { d.focus(); d.setSelectionRange(0, 0); } } },
        onpaste: (e) => onPaste(e, it.id, e.target)
      });
      const d = el(key + ':de', 'textarea', {
        class: 'desc', rows: 1, placeholder: 'What Claude should do', spellcheck: false, value: desc,
        oninput: (e) => { autosize(e.target); change(it.id, { text: joinPrompt(t.value, e.target.value) }); },
        onkeydown: (e) => { if (e.key === 'Backspace' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) { e.preventDefault(); t.focus(); t.setSelectionRange(t.value.length, t.value.length); } },
        onpaste: (e) => onPaste(e, it.id, e.target)
      });
      body.push(t, d);
    } else {
      body.push(el(key + ':tx', 'textarea', {
        class: 'note-text', rows: 1, placeholder: 'Note', spellcheck: false, value: String(it.text || ''), 'data-item': it.id,
        oninput: (e) => { autosize(e.target); change(it.id, { text: e.target.value }); },
        onpaste: (e) => onPaste(e, it.id, e.target)
      }));
    }
    if (open && images.length) body.push(imageStrip(key, it));
    if (st === 'failed' && it.error) body.push(el(key + ':err', 'div', { class: 'status err', text: it.error }));
    kids.push(el(key + ':b', 'div', {
      class: 'body',
      onfocusin: () => { if (isPrompt && where.type === 'session' && st === 'todo' && !it.draft) change(it.id, { draft: true }, { now: true }); },
      onfocusout: (e) => { if (!cache.get(key + ':b').contains(e.relatedTarget)) leave(it.id); }
    }, body));
    if (extra.tag) kids.push(el(key + ':tag', 'span', { class: 'tag', text: extra.tag, title: extra.tag }));
    kids.push(el(key + ':bs', 'div', { class: 'btns' }, buttons(it, where, ctx, key)));
    return el(key, 'div', { class: cls, 'data-id': it.id }, kids);
  }

  // Leaving a note or prompt: a new empty one goes away, a prompt you were writing may be sent now.
  function leave(id) {
    setTimeout(() => {
      const it = byId(id);
      if (!it) return;
      const row = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (row && row.contains(document.activeElement)) return;
      if (!String(it.text || '').trim() && !(it.images || []).some(Boolean)) {
        clearTimeout(saveTimers.get(id));
        local.delete(id);
        post({ t: 'remove', id });
        render();
        return;
      }
      if (it.draft) change(id, { draft: null }, { now: true });
      else if (saveTimers.has(id)) change(id, {}, { now: true });
    }, 0);
  }

  function imageStrip(key, it) {
    const open = isOpen('img:' + it.id, false);
    const images = it.images || [];
    const count = images.filter(Boolean).length;
    return el(key + ':im', 'div', {}, [
      el(key + ':imt', 'button', { class: 'images-toggle', type: 'button', onclick: () => toggle('img:' + it.id, false) }, [
        el(key + ':imc', 'span', { html: open ? I.down : I.right, style: 'display:flex' }),
        el(key + ':imi', 'span', { html: I.image, style: 'display:flex' }),
        el(key + ':iml', 'span', { text: `${count} image${count === 1 ? '' : 's'}` })
      ]),
      open ? el(key + ':ims', 'div', { class: 'images' }, images.map((name, i) => !name ? null : el(key + ':img' + i, 'div', {
        class: 'thumb', title: `[Image #${i + 1}]`, onclick: () => post({ t: 'openImage', name })
      }, [
        el(key + ':imgi' + i, 'img', { src: `${state.imageBase}/${encodeURIComponent(name)}`, alt: `Image ${i + 1}` }),
        el(key + ':imgn' + i, 'span', { class: 'n', text: `#${i + 1}` }),
        el(key + ':imgx' + i, 'button', { class: 'x', type: 'button', title: 'Remove picture', html: I.x, onclick: (e) => { e.stopPropagation(); post({ t: 'removeImage', id: it.id, index: i }); } })
      ]))) : null
    ]);
  }

  function buttons(it, where, ctx, key) {
    const st = M.status(it);
    const b = (name, o) => btn(key + ':' + name, o);
    const del = b('del', { icon: I.trash, title: 'Delete', fn: () => remove(it.id) });
    if (it.archived) {
      return [b('restore', { icon: I.restore, label: 'Restore', fn: () => change(it.id, { archived: null }, { now: true }) }), del];
    }
    if (where.type === 'deleted') {
      return [
        b('here', { icon: I.unpack, label: it.kind === 'note' ? 'To notes' : 'To todo', title: 'Move it to this level', fn: () => {
          const sec = M.sections(ctx, where.home);
          const list = it.kind === 'note' ? sec.notes : sec.todo;
          change(it.id, { place: where.home, order: M.between(list.length ? list[list.length - 1].order : null, null), status: it.kind === 'prompt' ? 'todo' : M.status(it) }, { now: true });
        } }),
        b('arch', { icon: I.archive, label: 'Archive', fn: () => change(it.id, { archived: true }, { now: true }) })
      ];
    }
    if (it.kind === 'note') return [b('arch', { icon: I.archive, label: 'Archive', fn: () => change(it.id, { archived: true }, { now: true }) }), del];
    if (where.type !== 'session') return [b('assign', { icon: I.assign, label: 'Assign to…', cls: 'assign', fn: () => post({ t: 'assign', id: it.id }) }), del];
    const s = ctx.sessionById.get(where.session);
    const terminal = s && (s.origin || 'vscode-terminal') === 'vscode-terminal' && s.shellPid > 0;
    if (st === 'doing') return [b('done', { icon: I.check, label: 'Mark done', fn: () => post({ t: 'markDone', id: it.id }) })];
    if (st === 'done') {
      return [
        b('again', { icon: I.copy, label: 'To todo', title: 'Copy it back to Todo', fn: () => {
          const id = newId();
          const { id: _, sentAt, doneAt, ...rest } = it;
          const todo = M.sections(ctx, it.place).todo;
          post({ t: 'put', id, patch: { ...rest, status: 'todo', created: Date.now(), order: M.between(todo.length ? todo[todo.length - 1].order : null, null) } });
        } }),
        b('arch', { icon: I.archive, label: 'Archive', fn: () => change(it.id, { archived: true }, { now: true }) })
      ];
    }
    if (it.sending) {
      const left = Math.max(1, Math.ceil((it.sending - Date.now()) / 1000));
      return [b('cancel', { icon: I.x, label: `Cancel ${left}s`, cls: 'warn keep', title: 'Sending by itself in a moment: Cancel stops it (and turns auto-send off)', fn: () => post({ t: 'cancel', id: it.id }) }), del];
    }
    if (!s) return [del];
    if (st === 'queued') return [b('wait', { icon: I.send, label: 'Sends when free', cls: 'waiting', title: 'Goes in as soon as the session is free. Click to keep it in Todo instead', fn: () => post({ t: 'cancel', id: it.id }) }), del];
    const label = !terminal ? 'Copy' : st === 'failed' ? 'Retry' : M.FREE.includes(s.state) ? 'Send now' : 'Send next';
    const title = !terminal ? 'Copy it, then paste it into the session' : M.FREE.includes(s.state) ? 'Type it into the session now' : 'Goes in as soon as Claude is done';
    return [b('send', { icon: !terminal ? I.copy : I.send, label, cls: 'primary', title, fn: () => post({ t: 'send', id: it.id }) }), del];
  }

  // ---------- sections ----------
  function section(key, kind, label, count, o, kids) {
    const dflt = o.open !== undefined ? o.open : true;
    const open = isOpen(key, dflt);
    const head = el(key + ':h', 'div', { class: 'head', onclick: () => toggle(key, dflt) }, [
      el(key + ':ch', 'span', { html: open ? I.down : I.right, style: 'display:flex' }),
      el(key + ':l', 'span', { class: 'label', text: label }),
      el(key + ':c', 'span', { class: 'count', text: String(count) }),
      o.hint ? el(key + ':hint', 'span', { class: 'hint', text: o.hint }) : null,
      el(key + ':sp', 'span', { class: 'spacer' }),
      o.tools || null,
      o.add ? btn(key + ':add', { icon: I.plus, label: o.add.label, cls: 'add', title: o.add.title, fn: () => { state.fold[key] = true; o.add.fn(); } }) : null
    ]);
    if (o.target) dropOnto(head, key, dflt, () => o.target);
    const list = open ? el(key + ':list', 'div', { class: 'list' }, kids.length ? kids : (o.empty ? [el(key + ':e', 'div', { class: 'empty', text: o.empty })] : [])) : null;
    if (list && o.target) dropList(list, o.target);
    return el(key, 'div', { class: 'section' + (o.nested ? ' nested' : ''), 'data-kind': kind }, [head, list]);
  }

  const stopOrderOf = (place) => {
    const p = (state.data.places || {})[place] || {};
    return typeof p.stopOrder === 'number' ? p.stopOrder : Infinity;
  };

  // A session's four lists (in its own pad, or opened inside a folder or the overview).
  function sessionSections(ctx, v, key, nested) {
    const place = v.place;
    const where = { type: 'session', key, session: v.id };
    const settings = v.settings || {};
    const target = (section) => ({ place, section, items: () => M.sections(M.context(dataNow()), place)[section] || [] });
    const notes = v.notes.map((it) => row(it, { ...where, type: 'note' }, ctx));
    const archived = archivedLine(ctx, v.archivedNotes, key, where);
    const todoRows = [];
    let stopShown = false;
    const stop = settings.autoSend ? stopLine(key, place) : null;
    v.todo.forEach((it, i) => {
      if (stop && !stopShown && (it.order || 0) >= stopOrderOf(place)) { todoRows.push(stop); stopShown = true; }
      todoRows.push(row(it, where, ctx, { num: i + 1 }));
    });
    if (stop && !stopShown) todoRows.push(stop);
    const list = [
      section(key + ':notes', 'notes', 'NOTES', v.notes.length, {
        nested, target: target('notes'),
        add: { label: 'Note', title: 'New note', fn: () => create(place, 'note', v.notes) }
      }, [...notes, ...archived]),
      section(key + ':doing', 'doing', 'DOING', v.doing.length, { nested, target: target('doing') }, v.doing.map((it) => row(it, where, ctx))),
      section(key + ':todo', 'todo', 'TODO', v.todo.length, {
        nested, target: target('todo'),
        add: { label: 'Prompt', title: 'New prompt', fn: () => create(place, 'prompt', v.todo) }
      }, todoRows),
      section(key + ':done', 'done', 'DONE', v.done.length, { nested, target: target('done'), open: !nested }, v.done.map((it) => row(it, where, ctx)))
    ];
    return list;
  }

  // "▸ 3 archived notes" under a place's notes: opens to show them, each with Restore.
  function archivedLine(ctx, list, key, where) {
    if (!list.length) return [];
    const open = isOpen(key + ':archOpen', false);
    return [
      el(key + ':arch', 'div', { class: 'empty', style: 'cursor:pointer', onclick: () => toggle(key + ':archOpen', false) }, [
        `${open ? '▾' : '▸'} ${list.length} archived note${list.length === 1 ? '' : 's'}`
      ]),
      ...(open ? list.map((it) => row(it, { ...where, type: 'note' }, ctx)) : [])
    ];
  }

  function stopLine(key, place) {
    return el(key + ':stop', 'div', {
      class: 'stop', 'data-stop': '1', draggable: true, title: 'Auto-send sends the prompts above this line. Drag it.',
      ondragstart: (e) => startDrag(e, { type: 'stop', place }, key + ':stop'), ondragend: endDrag
    }, ['auto-send stops here']);
  }

  // The data as it is now, with your unsaved changes.
  const dataNow = () => ({ ...state.data, items: items() });

  // A session as a row in a folder or the overview: opens in place to show its lists.
  function sessionPlace(ctx, s, key) {
    const foldKey = 'place:' + key + ':' + s.id;
    const open = isOpen(foldKey, false);
    const live = ctx.sessionById.get(s.id) || s;
    const meta = [STATE_LABEL[live.state] || live.state, ago(live.updated), s.todo ? `${s.todo} todo` : '', s.notes ? `${s.notes} note${s.notes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const pkey = key + ':s:' + s.id;
    const prow = el(pkey + ':row', 'div', { class: 'prow', onclick: () => toggle(foldKey, false) }, [
      el(pkey + ':hd', 'span', { class: 'fold', html: open ? I.down : I.right }),
      el(pkey + ':dot', 'span', { class: 'sdot', style: `--c:${STATE_COLOR[live.state] || '#7a7a7a'}` }, [el(pkey + ':doti', 'i', {})]),
      el(pkey + ':nm', 'span', { class: 'pname', text: s.name }),
      el(pkey + ':mt', 'span', { class: 'meta', text: meta }),
      el(pkey + ':sp', 'span', { class: 'spacer' }),
      el(pkey + ':bs', 'div', { class: 'btns' }, [
        btn(pkey + ':open', { icon: I.open, label: 'Open pad', title: 'Open its pad', fn: () => go({ kind: 'session', id: s.id }) }),
        btn(pkey + ':goto', { icon: I.terminal, title: 'Go to the session', fn: () => post({ t: 'goto', session: s.id }) })
      ])
    ]);
    dropOnto(prow, foldKey, false, (it) => ({ place: 'session:' + s.id, section: it.kind === 'note' ? 'notes' : 'todo', items: () => { const sec = M.sections(M.context(dataNow()), 'session:' + s.id); return it.kind === 'note' ? sec.notes : sec.todo; } }));
    const inner = open ? el(pkey + ':in', 'div', { class: 'inner' }, sessionSections(ctx, M.sessionView(ctx, s.id), pkey, true)) : null;
    return el(pkey, 'div', { class: 'place' + (open ? ' open' : ''), style: '--accent: var(--sessions)' }, [prow, inner]);
  }

  // A folder as a row in the overview (or a subfolder): opens in place to show its notes, todo and sessions.
  function folderPlace(ctx, f, key, depth) {
    const foldKey = 'place:' + key + ':' + f.id;
    const open = isOpen(foldKey, false);
    const pkey = key + ':f:' + f.id;
    const meta = [`${f.sessions} session${f.sessions === 1 ? '' : 's'}`, f.todo ? `${f.todo} todo` : '', f.notes ? `${f.notes} note${f.notes === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
    const sig = f.signal ? el(pkey + ':sig', 'span', { class: 'chip', style: `--c:${STATE_COLOR[f.signal]}` }, [el(pkey + ':sigd', 'span', { class: 'dot' }), STATE_LABEL[f.signal]])
      : f.working ? el(pkey + ':wk', 'span', { class: 'chip', style: `--c:${STATE_COLOR.working}` }, [el(pkey + ':wkd', 'span', { class: 'dot' }), `${f.working} working`]) : null;
    const prow = el(pkey + ':row', 'div', { class: 'prow', onclick: () => toggle(foldKey, false) }, [
      el(pkey + ':hd', 'span', { class: 'fold', html: open ? I.down : I.right }),
      el(pkey + ':ic', 'span', { html: I.folder, style: 'display:flex;color:var(--muted)' }),
      el(pkey + ':nm', 'span', { class: 'pname', style: 'font-weight:500' + (f.signal ? `;color:${STATE_COLOR[f.signal]}` : ''), text: f.name }),
      el(pkey + ':mt', 'span', { class: 'meta', text: meta }),
      sig,
      el(pkey + ':sp', 'span', { class: 'spacer' }),
      el(pkey + ':bs', 'div', { class: 'btns' }, [btn(pkey + ':open', { icon: I.open, label: 'Open pad', title: 'Open its pad', fn: () => go({ kind: 'folder', id: f.id }) })])
    ]);
    dropOnto(prow, foldKey, false, (it) => ({ place: 'folder:' + f.id, section: it.kind === 'note' ? 'notes' : 'todo', items: () => { const sec = M.sections(M.context(dataNow()), 'folder:' + f.id); return it.kind === 'note' ? sec.notes : sec.todo; } }));
    const inner = open && depth < 6 ? el(pkey + ':in', 'div', { class: 'inner' }, folderSections(ctx, M.folderView(ctx, f.id), pkey, true, depth + 1)) : null;
    return el(pkey, 'div', { class: 'place' + (open ? ' open' : ''), style: '--accent: var(--folders)' }, [prow, inner]);
  }

  // A folder's lists: Notes, Todo (its own prompts, to give to a session), Sessions, its subfolders, Deleted.
  function folderSections(ctx, v, key, nested, depth) {
    const place = v.place;
    const where = { type: 'folder', key };
    const target = (section) => ({ place, section, items: () => M.sections(M.context(dataNow()), place)[section] || [] });
    const out = [
      section(key + ':notes', 'notes', 'NOTES', v.notes.length, { nested, target: target('notes'), add: { label: 'Note', title: 'New note', fn: () => create(place, 'note', v.notes) } },
        [...v.notes.map((it) => row(it, { ...where, type: 'note' }, ctx)), ...archivedLine(ctx, v.archivedNotes, key, where)]),
      section(key + ':todo', 'todo', 'TODO', v.todo.length, { nested, target: target('todo'), add: { label: 'Prompt', title: 'New prompt', fn: () => create(place, 'prompt', v.todo) } },
        v.todo.map((it) => row(it, where, ctx))),
      section(key + ':sessions', 'sessions', 'SESSIONS', v.sessions.length, {
        nested, add: { label: 'Session', title: 'New session in this folder', fn: () => post({ t: 'newSession', folder: v.id }) }
      }, v.sessions.map((s) => sessionPlace(ctx, s, key)))
    ];
    if (v.folders.length) out.push(section(key + ':folders', 'folders', 'FOLDERS', v.folders.length, { nested }, v.folders.map((f) => folderPlace(ctx, f, key, depth || 0))));
    if (v.deleted.length) out.push(deletedSection(ctx, v.deleted, key, place, nested));
    return out;
  }

  // Gone sessions and folders: their notes and prompts wait here until you decide.
  function deletedSection(ctx, groups, key, home, nested) {
    return section(key + ':deleted', 'deleted', 'DELETED', groups.length, { nested }, groups.map((g) => {
      const gkey = key + ':g:' + g.place;
      const foldKey = 'del:' + g.place;
      const open = isOpen(foldKey, false);
      const when = g.since ? new Date(g.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      const canRestore = g.kind === 'session' || state.features.includes('folderId');
      const prow = el(gkey + ':row', 'div', { class: 'prow', onclick: () => toggle(foldKey, false) }, [
        el(gkey + ':hd', 'span', { class: 'fold', html: open ? I.down : I.right }),
        el(gkey + ':ic', 'span', { html: g.kind === 'folder' ? I.folder : I.terminal, style: 'display:flex;color:var(--muted)' }),
        el(gkey + ':nm', 'span', { class: 'pname', text: g.name }),
        el(gkey + ':mt', 'span', { class: 'meta', text: [g.kind, when && 'gone ' + when, `${g.items.length} item${g.items.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') }),
        el(gkey + ':sp', 'span', { class: 'spacer' }),
        el(gkey + ':bs', 'div', { class: 'btns' }, [
          canRestore ? btn(gkey + ':rs', { icon: I.restore, label: 'Restore', title: g.kind === 'session' ? 'Resume the session in a new tab' : 'Make the folder again, with everything that was in it', fn: () => post({ t: 'restore', place: g.place }) }) : null,
          btn(gkey + ':up', { icon: I.unpack, label: 'Unpack here', title: 'Move its notes and prompts to this level', fn: () => post({ t: 'unpack', place: g.place, to: home }) }),
          btn(gkey + ':ar', { icon: I.archive, label: 'Archive', fn: () => post({ t: 'archive', place: g.place }) })
        ])
      ]);
      const inner = open ? el(gkey + ':in', 'div', { class: 'inner' }, [el(gkey + ':list', 'div', { class: 'list' }, g.items.map((it) => row(it, { type: 'deleted', key: gkey, home }, ctx)))]) : null;
      return el(gkey, 'div', { class: 'place' + (open ? ' open' : ''), style: '--accent: var(--deleted)' }, [prow, inner]);
    }));
  }

  // ---------- the three levels ----------
  function go(level) {
    state.level = level;
    keep();
    post({ t: 'level', level });
    window.scrollTo(0, 0);
    render();
  }

  function chip(key, color, text) {
    return el(key, 'span', { class: 'chip', style: `--c:${color}` }, [el(key + ':d', 'span', { class: 'dot' }), text]);
  }

  function crumbs(ctx, path, name, iconHtml) {
    return el('crumbs', 'div', { class: 'crumbs' }, [
      el('crumbs:home', 'a', { title: 'Overview', html: I.home, style: 'display:flex', onclick: () => go({ kind: 'root' }) }),
      ...path.flatMap((p, i) => [el('crumbs:s' + i, 'span', { text: '›' }), el('crumbs:p' + i, 'a', { text: p.name, onclick: () => go({ kind: 'folder', id: p.id }) })]),
      el('crumbs:last', 'span', { text: '›' }),
      iconHtml ? el('crumbs:ic', 'span', { html: iconHtml, style: 'display:flex' }) : null,
      el('crumbs:name', 'span', { class: 'name', text: name })
    ]);
  }

  function sessionPage(ctx, v) {
    const s = v.session;
    const settings = v.settings || {};
    const board = settings.view === 'board';
    const live = ctx.sessionById.has(v.id);
    const terminal = live && (s.origin || 'vscode-terminal') === 'vscode-terminal' && s.shellPid > 0;
    const top = el('top', 'div', { class: 'top' }, [el('top:r1', 'div', { class: 'top-row', style: 'flex-wrap:wrap' }, [
      el('top:left', 'div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 240px' }, [
        crumbs(ctx, v.path, s.name),
        live ? chip('top:state', STATE_COLOR[s.state] || '#7a7a7a', `${STATE_LABEL[s.state] || s.state} ${ago(s.updated)}`) : chip('top:state', '#7a7a7a', 'gone')
      ]),
      el('top:tools', 'div', { style: 'display:flex;align-items:center;gap:8px;flex-shrink:0' }, [
        el('top:seg', 'div', { class: 'seg' }, [
          el('top:list', 'button', { class: board ? '' : 'on', title: 'List', type: 'button', html: I.list, onclick: () => post({ t: 'place', key: v.place, patch: { view: null } }) }),
          el('top:board', 'button', { class: board ? 'on' : '', title: 'Board', type: 'button', html: I.board, onclick: () => post({ t: 'place', key: v.place, patch: { view: 'board' } }) })
        ]),
        terminal ? el('top:auto', 'span', {
          class: 'switch' + (settings.autoSend ? ' on' : ''), title: 'When Claude finishes, the next prompt in Todo goes in by itself (down to the stop line)',
          onclick: () => post({ t: 'place', key: v.place, patch: { autoSend: settings.autoSend ? null : true } })
        }, [el('top:autok', 'span', { class: 'knob' }), el('top:autol', 'span', { class: 'label hint', text: 'Auto-send' })]) : null,
        live ? btn('top:goto', { icon: I.terminal, label: 'Go to session', fn: () => post({ t: 'goto', session: v.id }) }) : null
      ])
    ])]);
    const key = 'sess:' + v.id;
    let body;
    if (board) {
      const all = sessionSections(ctx, v, key, false);
      body = [el(key + ':board', 'div', { class: 'board' }, [all[2], all[1], all[3]])];
    } else body = sessionSections(ctx, v, key, false);
    return [top, el('content', 'div', { class: 'content' }, body)];
  }

  function folderPage(ctx, v) {
    const working = v.sessions.filter((s) => s.state === 'working' || s.state === 'background').length;
    const top = el('top', 'div', { class: 'top' }, [el('top:r1', 'div', { class: 'top-row' }, [
      crumbs(ctx, v.path, v.folder.name, I.folder),
      el('top:meta', 'span', { class: 'hint', style: 'color:var(--muted);font-size:12px;white-space:nowrap', text: `${v.sessions.length} session${v.sessions.length === 1 ? '' : 's'}` }),
      working ? chip('top:wk', STATE_COLOR.working, `${working} working`) : null,
      el('top:sp', 'span', { class: 'spacer' })
    ])]);
    return [top, el('content', 'div', { class: 'content' }, folderSections(ctx, v, 'fold:' + v.id, false, 0))];
  }

  function rootPage(ctx, v) {
    const q = state.filter.trim().toLowerCase();
    const hit = (it) => !q || String(it.text || '').toLowerCase().includes(q);
    const named = (x) => !q || String(x.name || '').toLowerCase().includes(q);
    const t = v.totals;
    const top = el('top', 'div', { class: 'top' }, [el('top:r1', 'div', { class: 'top-row', style: 'flex-wrap:wrap' }, [
      el('top:left', 'div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 260px;flex-wrap:wrap' }, [
        el('top:ic', 'span', { html: I.home, style: 'display:flex' }),
        el('top:name', 'span', { style: 'font-weight:600', text: 'All sessions' }),
        el('top:meta', 'span', { class: 'hint', style: 'color:var(--muted);font-size:12px', text: `${t.folders} folder${t.folders === 1 ? '' : 's'} · ${t.sessions} session${t.sessions === 1 ? '' : 's'}` }),
        t.working ? chip('top:w', STATE_COLOR.working, `${t.working} working`) : null,
        t.input ? chip('top:i', STATE_COLOR.input, `${t.input} needs you`) : null,
        t.done ? chip('top:d', STATE_COLOR.done, `${t.done} done`) : null,
        v.backlog.length ? el('top:a', 'span', { class: 'chip', style: '--c:var(--todo)', text: `${v.backlog.length} to assign` }) : null
      ]),
      el('top:f', 'label', { class: 'filter' }, [
        el('top:fi', 'span', { html: I.search, style: 'display:flex;color:var(--muted)' }),
        el('top:fq', 'input', { type: 'text', placeholder: 'Filter', value: state.filter, oninput: (e) => { state.filter = e.target.value; render(); } })
      ])
    ])]);
    const key = 'root';
    const target = (section) => ({ place: 'root', section, items: () => { const sec = M.sections(M.context(dataNow()), 'root'); return section === 'notes' ? sec.notes : sec.todo; } });
    const body = [
      section(key + ':notes', 'notes', 'NOTES', v.notes.length, { target: target('notes'), add: { label: 'Note', title: 'New note', fn: () => create('root', 'note', v.notes) } },
        [...v.notes.filter(hit).map((it) => row(it, { type: 'note', key }, ctx)), ...archivedLine(ctx, v.archivedNotes, key, { type: 'note', key })]),
      section(key + ':backlog', 'backlog', 'BACKLOG', v.backlog.length, {
        target: target('backlog'), hint: 'give each one to a session or folder',
        add: { label: 'Prompt', title: 'New prompt in the backlog', fn: () => create('root', 'prompt', v.backlog) }
      }, v.backlog.filter(hit).map((it) => row(it, { type: 'backlog', key }, ctx))),
      section(key + ':sessions', 'sessions', 'SESSIONS', v.sessions.length, {
        hint: 'not in a folder', add: { label: 'Session', title: 'New session', fn: () => post({ t: 'newSession' }) }
      }, v.sessions.filter(named).map((s) => sessionPlace(ctx, s, key))),
      section(key + ':folders', 'folders', 'FOLDERS', v.folders.length, {}, v.folders.filter(named).map((f) => folderPlace(ctx, f, key, 0)))
    ];
    if (v.deleted.length) body.push(deletedSection(ctx, v.deleted, key, 'root', false));
    body.push(section(key + ':archive', 'archive', 'ARCHIVE', v.archive.length, {
      open: false, hint: 'from everywhere',
      target: { place: 'root', section: 'archive', items: () => [] }
    }, v.archive.filter(hit).map((it) => row(it, { type: 'archive', key: key + ':ar' }, ctx, { tag: it.where }))));
    return [top, el('content', 'div', { class: 'content' }, body)];
  }

  // ---------- toast ----------
  function toast(text, action) {
    state.toast = { text, action, until: Date.now() + 6000 };
    render();
    setTimeout(() => { if (state.toast && state.toast.until <= Date.now()) { state.toast = null; render(); } }, 6100);
  }
  function toastEl() {
    if (!state.toast) return null;
    const t = state.toast;
    return el('toast', 'div', { class: 'toast' }, [
      el('toast:t', 'span', { text: t.text }),
      t.action ? el('toast:a', 'a', { text: t.action.label, onclick: () => { t.action.fn(); state.toast = null; render(); } }) : null
    ]);
  }

  // ---------- drawing ----------
  let frame = 0;
  function render() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function draw() {
    if (!state.data) return;
    used = new Set();
    const ctx = M.context(dataNow());
    const v = M.view(ctx, state.level);
    if (v.kind === 'root' && state.level.kind !== 'root') { state.level = { kind: 'root' }; keep(); }
    const page = v.kind === 'session' ? sessionPage(ctx, v) : v.kind === 'folder' ? folderPage(ctx, v) : rootPage(ctx, v);
    setKids(app, [...page, toastEl()]);
    for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
    for (const ta of app.querySelectorAll('textarea')) autosize(ta);
  }

  function focusItem(id) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = app.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!r) return;
      r.scrollIntoView({ block: 'nearest' });
      const ta = r.querySelector('textarea');
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }));
  }

  // From the Claude Sessions view: show this prompt (its section and the prompt open).
  function reveal(id) {
    const it = byId(id);
    if (!it) return;
    state.fold['item:' + id] = true;
    keep();
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const r = app.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!r) return;
      r.scrollIntoView({ block: 'center' });
      r.classList.add('flash');
      setTimeout(() => r.classList.remove('flash'), 1200);
    }));
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.t === 'model') {
      state.data = m.data;
      state.imageBase = m.imageBase || state.imageBase;
      state.features = m.features || [];
      if (m.level) { state.level = m.level; keep(); }
      // Your changes are in: what the extension has now is the truth (except what you are still typing).
      for (const [id, l] of [...local]) {
        const it = m.data.items.find((i) => i.id === id);
        const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest(`[data-id="${CSS.escape(id)}"]`);
        if (saveTimers.has(id) || typing) continue;
        if (!it && !l._new) { local.delete(id); continue; }
        if (it) local.delete(id);
      }
      render();
    } else if (m.t === 'focus') reveal(m.id);
    else if (m.t === 'toast') toast(m.text);
  });
  // Countdowns and "3m" ages stay fresh.
  setInterval(() => { if (state.data && !drag && !document.activeElement.matches('textarea, input')) render(); }, 1000);
  post({ t: 'ready', level: state.level });
})();
