// Injected on demand into tabs shared with Claude (never into other tabs).
// Runs in Firefox's isolated content-script world; talks to background.js via runtime messages.
(() => {
  if (window.__claudeBridgeLoaded) return;
  window.__claudeBridgeLoaded = true;

  // ---------------------------------------------------------------- refs
  const refToEl = new Map(); // "ref_N" -> WeakRef(element)
  const elToRef = new WeakMap();
  let refCounter = 0;

  function refFor(el) {
    let r = elToRef.get(el);
    if (!r) {
      r = 'ref_' + (++refCounter);
      elToRef.set(el, r);
      refToEl.set(r, new WeakRef(el));
    }
    return r;
  }
  function elFor(ref) {
    const w = refToEl.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Element ${ref} is gone (the page changed). Call read_page or find again.`);
    }
    return el;
  }
  function pruneRefs() {
    for (const [r, w] of refToEl) {
      const el = w.deref();
      if (!el || !el.isConnected) refToEl.delete(r);
    }
  }

  // ---------------------------------------------------------------- indicator
  let indicatorHost = null;
  function setIndicator(on) {
    if (!on) { indicatorHost?.remove(); indicatorHost = null; return; }
    if (indicatorHost?.isConnected) return;
    const attach = () => {
      if (indicatorHost?.isConnected) return;
      indicatorHost = document.createElement('claude-bridge-indicator');
      const root = indicatorHost.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        div{position:fixed;inset:0;pointer-events:none;z-index:2147483647;
        box-shadow:inset 0 0 0 2px rgba(217,119,87,.85),inset 0 0 14px rgba(217,119,87,.35);border-radius:6px}
      </style><div></div>`;
      document.documentElement.appendChild(indicatorHost);
    };
    if (document.documentElement) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  // ---------------------------------------------------------------- console capture
  // console-hook.js (injected first) owns the buffer.
  const consoleBuf = window.__claudeBridgeConsole || [];

  // ---------------------------------------------------------------- accessibility-ish tree
  const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox',
    'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'treeitem',
  ]);
  const TEXT_NAMED_ROLES = new Set([
    'link', 'button', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'treeitem', 'label', 'switch', 'checkbox', 'radio', 'cell', 'columnheader',
    'listitem', 'paragraph', 'generic', 'summary',
  ]);
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
    image: 'button', file: 'button', range: 'slider', search: 'searchbox', number: 'spinbutton',
  };
  const TAG_ROLES = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation',
    main: 'main', header: 'banner', footer: 'contentinfo', form: 'form', table: 'table',
    ul: 'list', ol: 'list', li: 'listitem', dialog: 'dialog', summary: 'button', label: 'label',
    aside: 'complementary', article: 'article', p: 'paragraph', iframe: 'iframe', video: 'video',
    audio: 'audio', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading',
    h6: 'heading', th: 'columnheader', td: 'cell', tr: 'row', option: 'option', section: 'region',
  };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'CLAUDE-BRIDGE-INDICATOR']);

  function getRole(el) {
    const ar = el.getAttribute('role');
    if (ar) return ar.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'hidden') return 'none';
      return INPUT_ROLES[t] || 'textbox';
    }
    if (tag === 'select' && (el.multiple || el.size > 1)) return 'listbox';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return 'generic';
  }

  const clean = (s, n = 100) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };

  function accName(el, role) {
    let n = el.getAttribute('aria-label');
    if (!n) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) n = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
    }
    if (!n && el.labels && el.labels.length) n = Array.from(el.labels, (l) => l.textContent).join(' ');
    if (!n && el.tagName === 'IMG') n = el.getAttribute('alt');
    if (!n && el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) n = el.value;
    if (!n && el.tagName === 'IFRAME') n = el.getAttribute('title') || el.src;
    if (!n && TEXT_NAMED_ROLES.has(role)) n = el.innerText;
    if (!n) n = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    return clean(n, role === 'paragraph' ? 160 : 100);
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti >= 0 && role !== 'generic') return true;
    if (role === 'generic' && el.parentElement) {
      // Divs/spans wired up with JS click handlers usually get cursor:pointer.
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer' && getComputedStyle(el.parentElement).cursor !== 'pointer') return true;
    }
    return false;
  }

  function visibleState(el) {
    // 'hidden' -> skip subtree, 'nobox' -> descend but don't emit, 'ok'
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
      return getComputedStyle(el).display === 'contents' ? 'nobox' : 'hidden';
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? 'ok' : 'nobox';
  }

  function extras(el, role) {
    const parts = [];
    if (role === 'heading') parts.push('level=' + (el.tagName.match(/H(\d)/)?.[1] || el.getAttribute('aria-level') || '?'));
    if (role === 'link') {
      const h = el.getAttribute('href');
      if (h && !h.startsWith('javascript:')) parts.push('href=' + clean(h, 80));
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const t = el.getAttribute('type');
      if (t && !['text', 'checkbox', 'radio'].includes(t)) parts.push('type=' + t);
      if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type === 'password') { if (el.value) parts.push('value=••••'); }
      else if (el.value) parts.push('value="' + clean(el.value, 60) + '"');
    }
    if (el.isContentEditable && role === 'textbox' && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      const v = el.innerText.trim();
      if (v) parts.push('value="' + clean(v, 60) + '"');
    }
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions?.[0];
      if (o) parts.push('selected="' + clean(o.textContent, 50) + '"');
      parts.push('options=' + el.options.length);
    }
    const ac = el.getAttribute('aria-checked'); if (ac) parts.push('checked=' + ac);
    const ae = el.getAttribute('aria-expanded'); if (ae) parts.push('expanded=' + ae);
    const as = el.getAttribute('aria-selected'); if (as === 'true') parts.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el === deepActive()) parts.push('focused');
    return parts.length ? ' ' + parts.join(' ') : '';
  }

  function* childrenOf(node) {
    const sr = node.openOrClosedShadowRoot || node.shadowRoot;
    if (sr) yield* sr.children;
    yield* node.children;
  }

  const STRUCTURAL = new Set(['heading', 'img', 'navigation', 'main', 'banner', 'contentinfo', 'form',
    'table', 'list', 'dialog', 'complementary', 'article', 'paragraph', 'iframe', 'video', 'audio', 'region', 'alert', 'alertdialog', 'tablist', 'menu', 'menubar', 'tree', 'grid', 'row', 'cell', 'columnheader']);

  function readPage({ filter = 'all', ref_id, max_chars = 40000, depth = 40 } = {}) {
    pruneRefs();
    const root = ref_id ? elFor(ref_id) : document.body || document.documentElement;
    const out = [];
    let len = 0, truncated = false;
    const interactiveOnly = filter === 'interactive';

    const emit = (line) => {
      if (len + line.length > max_chars) { truncated = true; return false; }
      out.push(line); len += line.length + 1; return true;
    };

    const walk = (el, indent, d) => {
      if (truncated || d > depth || SKIP_TAGS.has(el.tagName)) return;
      const vis = visibleState(el);
      if (vis === 'hidden') return;
      let nextIndent = indent;
      if (vis === 'ok') {
        const role = getRole(el);
        if (role === 'none' || el.getAttribute('aria-hidden') === 'true') return;
        const inter = isInteractive(el, role);
        let show = inter || (!interactiveOnly && STRUCTURAL.has(role));
        // Generic text leaves (e.g. <div>Some text</div>) in 'all' mode.
        if (!show && !interactiveOnly && role === 'generic' && el.children.length === 0 && el.textContent.trim()) {
          show = true;
        }
        if (show) {
          const name = accName(el, role);
          const r = role === 'generic' ? (inter ? 'clickable' : 'text') : role;
          if (!(r === 'text' && !name) && !(r === 'paragraph' && !name)) {
            const line = `${'  '.repeat(interactiveOnly ? 0 : indent)}- ${r}${name ? ` "${name.replace(/"/g, "'")}"` : ''} [${refFor(el)}]${extras(el, role)}`;
            if (!emit(line)) return;
            nextIndent = indent + 1;
          }
          // Don't descend into things whose text we already captured as their name.
          if (['link', 'button', 'heading', 'paragraph', 'option', 'textbox', 'combobox', 'listbox', 'text'].includes(r)
              && !el.querySelector('input,select,textarea,button,a[href]')) return;
        }
        if (el.tagName === 'IFRAME') return;
      }
      for (const c of childrenOf(el)) walk(c, nextIndent, d + 1);
    };
    walk(root, 0, 0);

    const header = `Page: ${document.title}\nURL: ${location.href}\nViewport: ${innerWidth}x${innerHeight}, scrolled to y=${Math.round(scrollY)} of ${document.documentElement.scrollHeight}\n`;
    return header + (out.length ? out.join('\n') : '(no matching elements)') +
      (truncated ? `\n…truncated at ${max_chars} chars. Use filter:"interactive", or ref_id to read a subtree.` : '');
  }

  function find({ query, limit = 15 }) {
    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/).filter(Boolean);
    const results = [];
    const walk = (el) => {
      if (SKIP_TAGS.has(el.tagName)) return;
      const vis = visibleState(el);
      if (vis === 'hidden') return;
      if (vis === 'ok') {
        const role = getRole(el);
        if (role !== 'none') {
          const inter = isInteractive(el, role);
          if (inter || STRUCTURAL.has(role) || role === 'label') {
            const name = accName(el, role).toLowerCase();
            const hay = `${role} ${name} ${el.id} ${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('type') || ''}`.toLowerCase();
            let score = 0;
            if (name === q) score += 10;
            else if (name.includes(q)) score += 6;
            for (const w of words) if (hay.includes(w)) score += 2;
            if (score > 0) {
              if (inter) score += 2;
              results.push({ el, role, name: accName(el, role), score });
            }
          }
        }
      }
      for (const c of childrenOf(el)) walk(c);
    };
    walk(document.body || document.documentElement);
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    if (!top.length) return `No elements matched "${query}". Try read_page or a screenshot.`;
    return top.map(({ el, role, name }) => {
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      return `- ${role} "${name.replace(/"/g, "'")}" [${refFor(el)}]${extras(el, role)}${inView ? '' : ' (offscreen)'}`;
    }).join('\n');
  }

  function pageText({ max_chars = 50000 } = {}) {
    const main = document.querySelector('article, main, [role=main]');
    const src = main && main.innerText.trim().length > 500 ? main : document.body;
    let text = (src?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    let note = '';
    if (text.length > max_chars) { text = text.slice(0, max_chars); note = `\n…truncated at ${max_chars} chars`; }
    return `Title: ${document.title}\nURL: ${location.href}\n\n${text}${note}`;
  }

  // ---------------------------------------------------------------- input synthesis
  function deepActive() {
    let a = document.activeElement;
    while (a && (a.openOrClosedShadowRoot || a.shadowRoot)?.activeElement) {
      a = (a.openOrClosedShadowRoot || a.shadowRoot).activeElement;
    }
    return a;
  }
  function deepFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el) {
      const sr = el.openOrClosedShadowRoot || el.shadowRoot;
      const inner = sr && sr.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  function describe(el) {
    if (!el) return 'nothing';
    const role = getRole(el);
    const name = accName(el, role);
    return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>${name ? ` "${clean(name, 50)}"` : ''}`;
  }
  function centerOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rects = el.getClientRects();
    const r = rects.length ? rects[0] : el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function mods(m = []) {
    const s = new Set(m.map((k) => k.toLowerCase()));
    return {
      ctrlKey: s.has('ctrl') || s.has('control'), shiftKey: s.has('shift'),
      altKey: s.has('alt') || s.has('option'), metaKey: s.has('meta') || s.has('cmd') || s.has('super'),
    };
  }
  function mouse(el, type, x, y, extra = {}) {
    const isPointer = type.startsWith('pointer');
    const Ctor = isPointer ? PointerEvent : MouseEvent;
    const init = {
      bubbles: !['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave'].includes(type),
      cancelable: true, composed: true, clientX: x, clientY: y,
      screenX: x + (window.mozInnerScreenX || 0), screenY: y + (window.mozInnerScreenY || 0),
      button: 0, buttons: 0, detail: 1, ...extra,
    };
    if (isPointer) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
    return el.dispatchEvent(new Ctor(type, init));
  }
  const FOCUSABLE = 'a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable=""],[contenteditable="true"]';

  function resolveTarget({ ref, x, y }) {
    if (ref) {
      const el = elFor(ref);
      const c = centerOf(el);
      const hit = deepFromPoint(c.x, c.y);
      // Prefer the real topmost element at that point if it's inside the ref'd element.
      return { el: hit && (el === hit || el.contains(hit)) ? hit : el, x: c.x, y: c.y };
    }
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('Need either ref or coordinate.');
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
      throw new Error(`Coordinate (${Math.round(x)},${Math.round(y)}) is outside the ${innerWidth}x${innerHeight} viewport.`);
    }
    const el = deepFromPoint(x, y);
    if (!el) throw new Error('No element at that point.');
    return { el, x, y };
  }

  function click({ ref, x, y, button = 'left', clickCount = 1, modifiers }) {
    const t = resolveTarget({ ref, x, y });
    const { el } = t;
    const m = mods(modifiers);
    const btn = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    const btns = btn === 2 ? 2 : btn === 1 ? 4 : 1;
    mouse(el, 'pointerover', t.x, t.y, m); mouse(el, 'pointerenter', t.x, t.y, m);
    mouse(el, 'mouseover', t.x, t.y, m); mouse(el, 'mouseenter', t.x, t.y, m);
    mouse(el, 'pointermove', t.x, t.y, m); mouse(el, 'mousemove', t.x, t.y, m);
    for (let i = 1; i <= clickCount; i++) {
      mouse(el, 'pointerdown', t.x, t.y, { ...m, button: btn, buttons: btns, detail: i });
      const downOk = mouse(el, 'mousedown', t.x, t.y, { ...m, button: btn, buttons: btns, detail: i });
      if (downOk && i === 1 && btn === 0) {
        const f = el.closest(FOCUSABLE) || (el.isContentEditable ? el : null);
        if (f) { f.focus({ preventScroll: true }); placeCaret(t.x, t.y); }
        else if (deepActive() && deepActive() !== document.body) deepActive().blur();
      }
      mouse(el, 'pointerup', t.x, t.y, { ...m, button: btn, detail: i });
      mouse(el, 'mouseup', t.x, t.y, { ...m, button: btn, detail: i });
      if (btn === 0) mouse(el, 'click', t.x, t.y, { ...m, detail: i });
      else if (btn === 1) mouse(el, 'auxclick', t.x, t.y, { ...m, button: 1, detail: i });
      if (i === 2 && btn === 0) mouse(el, 'dblclick', t.x, t.y, { ...m, detail: 2 });
    }
    if (btn === 2) mouse(el, 'contextmenu', t.x, t.y, { ...m, button: 2 });
    if (clickCount >= 3) {
      const f = el.closest('input,textarea');
      if (f && f.select) f.select();
    }
    return `${button === 'left' ? '' : button + '-'}${['', 'clicked', 'double-clicked', 'triple-clicked'][Math.min(clickCount, 3)]} ${describe(el)} at (${Math.round(t.x)},${Math.round(t.y)})`;
  }

  // Synthetic clicks don't move the caret, so put it where a real click would.
  function placeCaret(x, y) {
    const a = deepActive();
    if (!a || !(isTextField(a) || a.isContentEditable)) return;
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return;
    try {
      if (isTextField(a)) {
        const off = pos.offsetNode === a ? pos.offset : a.value.length;
        a.setSelectionRange(off, off);
      } else if (a.contains(pos.offsetNode)) {
        getSelection().collapse(pos.offsetNode, pos.offset);
      }
    } catch {}
  }

  function hover({ ref, x, y }) {
    const t = resolveTarget({ ref, x, y });
    for (const ty of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(t.el, ty, t.x, t.y);
    return `Hovered ${describe(t.el)} (note: CSS :hover styles can't be triggered by extensions)`;
  }

  function drag({ x0, y0, x1, y1 }) {
    const a = resolveTarget({ x: x0, y: y0 });
    mouse(a.el, 'pointerdown', x0, y0, { buttons: 1 });
    mouse(a.el, 'mousedown', x0, y0, { buttons: 1 });
    const steps = 8;
    let last = a.el;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps, y = y0 + ((y1 - y0) * i) / steps;
      last = deepFromPoint(x, y) || last;
      mouse(last, 'pointermove', x, y, { buttons: 1 });
      mouse(last, 'mousemove', x, y, { buttons: 1 });
    }
    mouse(last, 'pointerup', x1, y1);
    mouse(last, 'mouseup', x1, y1);
    return `Dragged from ${describe(a.el)} to ${describe(last)}`;
  }

  const isTextField = (el) =>
    el && ((el.tagName === 'TEXTAREA') ||
      (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(el.type)));

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function insertText(el, text) {
    if (isTextField(el)) {
      const before = el.value;
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch {}
      if (ok && el.value !== before) return;
      // Fallback for inputs where execCommand doesn't apply (e.g. type=number/email).
      let start = null, end = null;
      try { start = el.selectionStart; end = el.selectionEnd; } catch {}
      let next;
      if (start == null) next = el.value + text;
      else next = el.value.slice(0, start) + text + el.value.slice(end);
      setNativeValue(el, next);
      try { if (start != null) el.setSelectionRange(start + text.length, start + text.length); } catch {}
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      return;
    }
    if (el.isContentEditable) {
      if (!document.execCommand('insertText', false, text)) throw new Error('Could not insert text into this editor.');
      return;
    }
    throw new Error(`Focused element ${describe(el)} isn't a text field. Click an input first.`);
  }

  const KEY_ALIASES = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
    delete: 'Delete', del: 'Delete', space: ' ', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
    right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  };
  const KEY_CODES = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ' ': 32, ArrowUp: 38, ArrowDown: 40,
    ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  function parseCombo(combo) {
    const parts = combo.split('+');
    let key = parts.pop();
    if (key === '' && combo.endsWith('+')) key = '+';
    const m = mods(parts);
    const low = key.toLowerCase();
    if (KEY_ALIASES[low]) key = KEY_ALIASES[low];
    else if (/^f\d{1,2}$/.test(low)) key = key.toUpperCase();
    else if (key.length === 1 && !m.shiftKey) key = key.toLowerCase();
    const code = key.length === 1
      ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /\d/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : '')
      : key;
    const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    return { key, code, keyCode, ...m };
  }
  function kbd(el, type, k) {
    return el.dispatchEvent(new KeyboardEvent(type, {
      key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, charCode: type === 'keypress' ? k.key.charCodeAt(0) : 0,
      ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, metaKey: k.metaKey,
      bubbles: true, cancelable: true, composed: true,
    }));
  }
  function tabbables() {
    return Array.from(document.querySelectorAll(FOCUSABLE)).filter((e) =>
      !e.disabled && e.getAttribute('tabindex') !== '-1' && e.checkVisibility());
  }
  function scrollPage(dy) { (document.scrollingElement || document.documentElement).scrollBy(0, dy); }

  function pressOne(k) {
    const el = deepActive() || document.body;
    const printable = k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey;
    if (!kbd(el, 'keydown', k)) { kbd(el, 'keyup', k); return; }
    const accel = k.ctrlKey || k.metaKey;
    if (printable) {
      kbd(el, 'keypress', k);
      if (isTextField(el) || el.isContentEditable) insertText(el, k.key);
      else if (k.key === ' ') {
        if (el.matches?.('button,input[type=checkbox],input[type=radio],summary,[role=button],[role=checkbox]')) el.click();
        else scrollPage(innerHeight * 0.8);
      }
    } else if (accel && k.key === 'a') {
      if (isTextField(el)) el.select(); else document.execCommand('selectAll');
    } else switch (k.key) {
      case 'Enter':
        kbd(el, 'keypress', k);
        if (el.tagName === 'TEXTAREA') insertText(el, '\n');
        else if (el.isContentEditable) document.execCommand(k.shiftKey ? 'insertLineBreak' : 'insertParagraph');
        else if (el.tagName === 'INPUT' && el.form) {
          if (isTextField(el)) el.form.requestSubmit(); else el.click();
        } else if (el.matches?.('a[href],button,summary,[role=button],[role=link],input[type=checkbox],input[type=radio]')) el.click();
        break;
      case 'Backspace': if (isTextField(el) || el.isContentEditable) document.execCommand('delete'); break;
      case 'Delete': if (isTextField(el) || el.isContentEditable) document.execCommand('forwardDelete'); break;
      case 'Tab': {
        const list = tabbables();
        if (list.length) {
          const i = list.indexOf(el);
          const next = k.shiftKey ? list[(i <= 0 ? list.length : i) - 1] : list[(i + 1) % list.length];
          next.focus();
        }
        break;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'Home': case 'End': case 'ArrowUp': case 'ArrowDown':
        if (el.isContentEditable) {
          const back = k.key === 'ArrowLeft' || k.key === 'Home' || k.key === 'ArrowUp';
          const unit = k.key.startsWith('Arrow') ? (k.key === 'ArrowUp' || k.key === 'ArrowDown' ? 'line' : (k.ctrlKey || k.altKey ? 'word' : 'character')) : 'lineboundary';
          getSelection().modify(k.shiftKey ? 'extend' : 'move', back ? 'backward' : 'forward', unit);
          break;
        }
        if (k.key === 'ArrowUp' || k.key === 'ArrowDown') {
          if (el.tagName === 'SELECT') {
            const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + (k.key === 'ArrowDown' ? 1 : -1)));
            if (i !== el.selectedIndex) { el.selectedIndex = i; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
          } else if (!isTextField(el)) scrollPage(k.key === 'ArrowDown' ? 60 : -60);
          break;
        }
        if (isTextField(el)) {
          try {
            const p = el.selectionStart, n = el.value.length;
            const to = k.key === 'Home' ? 0 : k.key === 'End' ? n : Math.max(0, Math.min(n, p + (k.key === 'ArrowLeft' ? -1 : 1)));
            el.setSelectionRange(to, to);
          } catch {}
        } else if (k.key === 'Home' || k.key === 'End') {
          (document.scrollingElement || document.documentElement).scrollTo(0, k.key === 'Home' ? 0 : 1e9);
        }
        break;
      case 'PageDown': case 'PageUp':
        if (!isTextField(el)) scrollPage((k.key === 'PageDown' ? 1 : -1) * innerHeight * 0.85);
        break;
    }
    kbd(deepActive() || document.body, 'keyup', k);
  }

  function pressKeys({ text, repeat = 1 }) {
    const combos = text.trim().split(/\s+/);
    for (let r = 0; r < Math.min(repeat, 100); r++) for (const c of combos) pressOne(parseCombo(c));
    return `Pressed ${text}${repeat > 1 ? ` ×${repeat}` : ''} on ${describe(deepActive())}`;
  }

  function type({ text }) {
    const el = deepActive();
    if (!el || el === document.body || el === document.documentElement) {
      throw new Error('Nothing is focused. Click the input you want to type into first.');
    }
    if (!isTextField(el) && !el.isContentEditable) {
      throw new Error(`Focused element ${describe(el)} isn't a text field. Click an input first.`);
    }
    if (text.length <= 200) {
      // Per-character key events so autocomplete/shortcut listeners fire.
      for (const ch of text) {
        if (ch === '\n') { pressOne(parseCombo('Enter')); continue; }
        const k = { key: ch, code: '', keyCode: ch.toUpperCase().charCodeAt(0), ctrlKey: false, shiftKey: ch !== ch.toLowerCase(), altKey: false, metaKey: false };
        const target = deepActive() || el;
        if (kbd(target, 'keydown', k)) { kbd(target, 'keypress', k); insertText(target, ch); }
        kbd(target, 'keyup', k);
      }
    } else {
      insertText(el, text);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Typed ${text.length} chars into ${describe(el)}`;
  }

  function scrollableAncestor(el, vertical) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const ov = vertical ? cs.overflowY : cs.overflowX;
      if (/(auto|scroll|overlay)/.test(ov) &&
        (vertical ? n.scrollHeight > n.clientHeight + 1 : n.scrollWidth > n.clientWidth + 1)) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scroll({ x, y, direction = 'down', amount = 3 }) {
    const px = Math.round(amount * 100);
    const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
    const dy = direction === 'up' ? -px : direction === 'down' ? px : 0;
    const cx = typeof x === 'number' ? x : innerWidth / 2, cy = typeof y === 'number' ? y : innerHeight / 2;
    const el = deepFromPoint(cx, cy) || document.documentElement;
    const wheelOk = el.dispatchEvent(new WheelEvent('wheel', {
      deltaX: dx, deltaY: dy, deltaMode: 0, clientX: cx, clientY: cy, bubbles: true, cancelable: true, composed: true,
    }));
    const target = scrollableAncestor(el, dy !== 0);
    const before = [target.scrollLeft, target.scrollTop];
    if (wheelOk) target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    const moved = before[0] !== target.scrollLeft || before[1] !== target.scrollTop;
    const isDoc = target === document.scrollingElement || target === document.documentElement;
    return `Scrolled ${direction} ${px}px ${isDoc ? 'the page' : 'inside ' + describe(target)}` +
      (moved ? `; now at y=${Math.round(target.scrollTop)} of ${target.scrollHeight - target.clientHeight}` : wheelOk ? ' (already at the edge)' : ' (page handled the wheel event itself)');
  }

  function scrollTo({ ref }) {
    const el = elFor(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return `Scrolled ${describe(el)} into view`;
  }

  function formInput({ ref, value }) {
    const el = elFor(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const fire = () => {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    };
    if (el.tagName === 'SELECT') {
      const want = String(value).toLowerCase();
      const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === want) ||
        Array.from(el.options).find((o) => o.textContent.trim().toLowerCase() === want) ||
        Array.from(el.options).find((o) => o.textContent.trim().toLowerCase().includes(want));
      if (!opt) throw new Error(`No option matching "${value}". Options: ${Array.from(el.options, (o) => o.textContent.trim()).slice(0, 30).join(' | ')}`);
      el.focus();
      setNativeValue(el, opt.value);
      fire();
      return `Selected "${opt.textContent.trim()}" in ${describe(el)}`;
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const want = value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
      if (el.checked !== want) el.click();
      return `${describe(el)} is now ${el.checked ? 'checked' : 'unchecked'}`;
    }
    if (isTextField(el)) {
      el.focus();
      setNativeValue(el, String(value));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: String(value) }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return `Set ${describe(el)} to "${clean(String(value), 60)}"`;
    }
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(value));
      return `Replaced text in ${describe(el)}`;
    }
    const role = getRole(el);
    if (['checkbox', 'switch', 'radio'].includes(role)) {
      const want = value === true || value === 'true';
      if ((el.getAttribute('aria-checked') === 'true') !== want) click({ ref });
      return `Toggled ${describe(el)}`;
    }
    throw new Error(`${describe(el)} isn't a form field. Use computer actions instead.`);
  }

  function readConsole({ pattern, only_errors, clear, limit = 100 }) {
    let items = consoleBuf.slice();
    if (only_errors) items = items.filter((m) => m.level === 'error' || m.level === 'exception');
    if (pattern) { const re = new RegExp(pattern, 'i'); items = items.filter((m) => re.test(m.text)); }
    items = items.slice(-limit);
    if (clear) consoleBuf.length = 0;
    if (!items.length) return 'No console messages captured on this page yet (messages are captured from when Claude first touched the page or from page load, and reset on navigation).';
    return items.map((m) => `[${m.level}] ${m.text}`).join('\n');
  }

  // ---------------------------------------------------------------- dispatcher
  const handlers = {
    ping: () => 'pong',
    indicator: ({ on }) => setIndicator(on),
    viewport: () => ({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, dpr: devicePixelRatio }),
    read_page: readPage,
    find,
    text: pageText,
    click,
    hover,
    drag,
    type,
    key: pressKeys,
    scroll,
    scroll_to: scrollTo,
    form_input: formInput,
    console: readConsole,
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__claudeBridge !== true) return;
    const h = handlers[msg.cmd];
    if (!h) return Promise.resolve({ error: 'unknown command ' + msg.cmd });
    try {
      return Promise.resolve(h(msg.args || {})).then((result) => ({ result }), (e) => ({ error: String(e?.message || e) }));
    } catch (e) {
      return Promise.resolve({ error: String(e?.message || e) });
    }
  });
})();
