const $ = (id) => document.getElementById(id);
const send = (m) => browser.runtime.sendMessage({ ...m });

async function render() {
  const s = await send({ popup: 'status' });
  const dot = document.createElement('span');
  dot.className = 'dot' + (s.connected ? ' on' : '');
  $('conn').replaceChildren(dot, s.connected ? 'Connected' : s.busy ? 'Other browser connected' : 'Waiting for Claude');
  $('reconnect').textContent = s.busy ? 'Use this browser' : 'Reconnect';
  const btn = $('share');
  btn.textContent = s.activeShared ? 'Stop sharing this tab' : 'Share this tab with Claude';
  btn.className = s.activeShared ? 'ghost' : '';
  btn.disabled = !s.activeShared && !s.activeScriptable;
  $('shareNote').hidden = s.activeShared || s.activeScriptable;
  $('shareNote').textContent = 'Browser-internal pages can\'t be shared.';
  btn.onclick = async () => { await send({ popup: 'share', tabId: s.activeId, on: !s.activeShared }); render(); };

  const ul = $('tabs');
  ul.textContent = '';
  if (!s.shared.length) {
    const li = document.createElement('li');
    li.className = 'status';
    li.textContent = 'None yet — Claude can also open its own.';
    ul.appendChild(li);
  }
  for (const t of s.shared) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = t.title || t.url;
    span.title = t.url;
    const x = document.createElement('a');
    x.textContent = '×';
    x.title = 'Stop sharing';
    x.onclick = async () => { await send({ popup: 'share', tabId: t.id, on: false }); render(); };
    li.append(span, x);
    ul.appendChild(li);
  }
  $('pause').checked = s.paused;
  $('allowAll').checked = s.allowAll;
  if (document.activeElement !== $('port')) $('port').value = s.port;
}

$('pause').onchange = (e) => send({ popup: 'pause', on: e.target.checked });
$('allowAll').onchange = (e) => send({ popup: 'allowAll', on: e.target.checked });
$('port').onchange = (e) => send({ popup: 'port', port: e.target.value }).then(render);
$('reconnect').onclick = () => send({ popup: 'reconnect' }).then(() => setTimeout(render, 600));

send({ popup: 'wake' }).catch(() => {});
render();
setInterval(render, 1500);
