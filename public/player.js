(() => {
'use strict';
const $ = s => document.querySelector(s);
const app = $('#app'), sheet = $('#sheet');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let token = localStorage.getItem('mafia_token');
let view = null, es = null;
const open = new Set(JSON.parse(sessionStorage.getItem('mafia_open') || '["personality","description","story","secrets"]'));

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong'), { status: r.status });
  return d;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

/* ---------------------------------------------------------------- join */
async function renderJoin(msg) {
  let info = { title: 'Mafia Night', rules: '' };
  try { info = await api('/api/info'); } catch (e) {}
  document.title = info.title;
  app.innerHTML = `
    <h1 class="big">${esc(info.title)}</h1>
    ${info.rules ? `<p class="muted pre">${esc(info.rules)}</p>` : ''}
    ${msg ? `<div class="notice">${esc(msg)}</div>` : ''}
    <label class="lbl" for="name">Your name</label>
    <input id="name" class="input" maxlength="24" autocomplete="off" placeholder="What should we call you?">
    <button id="joinBtn" class="btn primary block">Join the game</button>`;
  $('#joinBtn').onclick = doJoin;
  $('#name').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
}
async function doJoin() {
  try {
    const r = await api('/api/join', { name: $('#name').value });
    token = r.token; localStorage.setItem('mafia_token', token);
    start();
  } catch (e) { toast(e.message); }
}

/* ------------------------------------------------------------ live data */
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events?token=' + encodeURIComponent(token));
  es.addEventListener('update', refresh);
}
async function refresh() {
  if (!token) return renderJoin();
  try { view = await api('/api/me?token=' + encodeURIComponent(token)); document.title = view.title; render(); }
  catch (e) {
    if (e.status === 401) {
      token = null; localStorage.removeItem('mafia_token'); if (es) es.close();
      renderJoin('Your session ended. Join again with your name.');
    }
  }
}
function start() { connect(); refresh(); }

/* --------------------------------------------------------------- render */
const sec = (k, title, text, cls = '') => text
  ? `<details class="sec ${cls}" data-k="${esc(k)}" ${open.has(k) ? 'open' : ''}><summary>${esc(title)}</summary><div class="pre">${esc(text)}</div></details>` : '';

function charCard(v) {
  const c = v.character;
  if (!c) return `<section class="card"><h2>Waiting for your character</h2><p class="muted">The host hasn't dealt your role yet. This page will update by itself.</p></section>`;
  return `<section class="card dossier">
    <div class="dossier-head">
      <div><h2>${esc(c.name)}</h2><div class="role">${esc(c.role)}</div></div>
      <div class="stamp" style="--tc:${esc(c.teamColor)}">${esc(c.teamLabel)}</div>
    </div>
    ${c.tagline ? `<p class="tagline">${esc(c.tagline)}</p>` : ''}
    ${sec('personality', 'Personality', c.personality)}
    ${sec('description', 'Description', c.description)}
    ${sec('story', 'Your story', c.story)}
    ${sec('secrets', 'Secrets (private)', c.secrets, 'private')}
    ${(c.extra || []).map((x, i) => sec('x' + i, x.title || 'Notes', x.text)).join('')}
  </section>`;
}

function statusText(v, a) {
  switch (a.status) {
    case 'ready': return 'Ready. Tap to use.';
    case 'dead': return 'You are out of the game.';
    case 'spent': return 'No uses left.';
    case 'waiting': return 'Waiting for the host to open this.';
    default: return v.phase === 'discussion' ? 'Locked during discussion.' : 'Not available right now.';
  }
}
function abilitiesBlock(v) {
  if (!v.abilities.length) return '';
  return `<section class="card"><h3>Your abilities</h3>${v.abilities.map(a => `
    <div class="ability">
      <button class="btn ${a.status === 'ready' ? 'primary' : ''}" data-act="ability" data-id="${esc(a.id)}" ${a.status === 'ready' ? '' : 'disabled'}>
        ${esc(a.label)}${a.usesLeft != null ? ` (${a.usesLeft} left)` : ''}</button>
      ${a.description ? `<div class="muted small pre" style="margin-top:6px">${esc(a.description)}</div>` : ''}
      <div class="st ${a.status}">${statusText(v, a)}</div>
    </div>`).join('')}</section>`;
}

function voteBlock(v) {
  if (!v.voting) return '';
  const alive = v.players.filter(p => p.alive);
  const mine = v.voting.myVote;
  if (!v.voting.canVote) return `<section class="card"><h3>Voting</h3><p class="muted">Eliminated players can't vote.</p></section>`;
  return `<section class="card"><h3>Who do you vote out?</h3>
    ${alive.map(p => `<button class="btn pick ${mine === p.id ? 'sel' : ''}" data-act="vote" data-id="${esc(p.id)}">${esc(p.name)}${p.id === v.me.id ? ' (you)' : ''}</button>`).join('')}
    <button class="btn pick ${mine === 'abstain' ? 'sel' : ''}" data-act="vote" data-id="abstain">Abstain</button>
    <p class="muted small">${mine ? 'Vote saved. You can change it until the host closes voting.' : 'Tap a name to vote.'}</p></section>`;
}

function msgBlock(v) {
  if (!v.messages.length) return '';
  const fmt = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<section class="card"><h3>Private messages</h3>${v.messages.slice().reverse().map(m =>
    `<div class="msg ${m.from}"><b>${m.from === 'host' ? 'Host' : 'You'}</b> <span class="muted small">${fmt(m.t)}</span><div class="pre">${esc(m.text)}</div></div>`).join('')}</section>`;
}

function playersBlock(v) {
  return `<section class="card"><h3>Players (${v.players.filter(p => p.alive).length} alive)</h3>
    <div class="plist">${v.players.map(p => `<span class="chip ${p.alive ? '' : 'out'}">${esc(p.name)}</span>`).join('')}</div></section>`;
}

function render() {
  const v = view;
  app.innerHTML = `
    <header class="top"><div class="title">${esc(v.title)}</div><div class="who">${esc(v.me.name)}</div></header>
    <div class="phase phase-${esc(v.phase)}">${esc(v.phaseLabel)}</div>
    ${v.announcement ? `<div class="announce">${esc(v.announcement)}</div>` : ''}
    ${!v.me.alive ? `<div class="deadbar">You have been eliminated. Stay quiet and enjoy the show.</div>` : ''}
    ${voteBlock(v)}${abilitiesBlock(v)}${charCard(v)}${msgBlock(v)}${playersBlock(v)}`;
}

/* ----------------------------------------------------------- interaction */
app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  if (b.dataset.act === 'ability') openSheet(view.abilities.find(a => a.id === b.dataset.id));
  if (b.dataset.act === 'vote') castVote(b.dataset.id);
});
app.addEventListener('toggle', e => {
  const d = e.target;
  if (d.dataset && d.dataset.k) {
    d.open ? open.add(d.dataset.k) : open.delete(d.dataset.k);
    sessionStorage.setItem('mafia_open', JSON.stringify([...open]));
  }
}, true);

async function castVote(id) {
  try { await api('/api/vote', { token, targetId: id }); } catch (e) { toast(e.message); }
  refresh();
}

function closeSheet() { sheet.classList.add('hidden'); sheet.innerHTML = ''; }
function openSheet(a) {
  if (!a) return;
  let opts = [];
  if (a.target !== 'none') {
    opts = view.players.filter(p =>
      (a.target === 'any' || (a.target === 'alive' && p.alive) || (a.target === 'dead' && !p.alive)) &&
      (a.allowSelf || p.id !== view.me.id));
  }
  let sel = null;
  const draw = () => {
    sheet.innerHTML = `<div class="backdrop" data-close></div><div class="panel">
      <h3>${esc(a.label)}</h3>
      ${a.description ? `<p class="muted pre">${esc(a.description)}</p>` : ''}
      ${a.target !== 'none' ? (opts.length
        ? opts.map(p => `<button class="btn pick ${sel === p.id ? 'sel' : ''}" data-pick="${esc(p.id)}">${esc(p.name)}${p.id === view.me.id ? ' (you)' : ''}</button>`).join('')
        : '<p class="muted">No valid targets right now.</p>') : ''}
      <div class="row"><button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="go" ${a.target !== 'none' && !sel ? 'disabled' : ''}>Confirm</button></div></div>`;
    sheet.classList.remove('hidden');
  };
  sheet.onclick = async e => {
    if (e.target.closest('[data-close]')) return closeSheet();
    const pk = e.target.closest('[data-pick]');
    if (pk) { sel = pk.dataset.pick; return draw(); }
    if (e.target.closest('#go') && !e.target.closest('#go').disabled) {
      try { await api('/api/ability', { token, abilityId: a.id, targetId: sel }); toast('Done. The host has been told.'); }
      catch (err) { toast(err.message); }
      closeSheet(); refresh();
    }
  };
  draw();
}

start();
})();
