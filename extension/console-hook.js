// Tiny early-injected script: records console output and uncaught errors so Claude can read them.
// Registered at document_start only for the sites open in shared tabs; the buffer stays in
// memory in the page and is only read when Claude asks for it.
(() => {
  if (window.__claudeBridgeConsole) return;
  const buf = [];
  window.__claudeBridgeConsole = buf;

  const fmtArg = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch { try { return String(a); } catch { return '[unprintable]'; } }
  };
  const record = (level, args) => {
    buf.push({ level, text: Array.from(args, fmtArg).join(' ').slice(0, 2000), t: Date.now() });
    if (buf.length > 500) buf.shift();
  };

  try {
    const pc = window.wrappedJSObject.console;
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const orig = pc[level];
      exportFunction(function (...args) {
        try { record(level, args); } catch {}
        // Spread (not apply): page code can't read a content-script array's length.
        return orig.call(pc, ...args);
      }, pc, { defineAs: level });
    }
  } catch {}
  window.addEventListener('error', (e) => {
    record('exception', [`${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    record('exception', ['Unhandled promise rejection: ' + fmtArg(e.reason)]);
  });
})();
