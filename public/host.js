(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let key = localStorage.getItem('mafia_host_key') || '';
let S = null, es = null, pendingRender = false;

async function call(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'x-host-key': key }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Error'), { status: r.status });
  return d;
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2800);
}
const act = (type, data = {}) => call('/api/host/action', Object.assign({ type }, data)).then(refresh).catch(e => toast(e.message));

/* ---------------------------------------------------------------- login */
function showLogin(msg) {
  $('#dash').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#pwErr').textContent = msg || '';
}
async function tryLogin() {
  key = $('#pw').value; localStorage.setItem('mafia_host_key', key);
  await refresh(true);
}
$('#pwGo').onclick = tryLogin;
$('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });

async function refresh(fromLogin) {
  try {
    S = await call('/api/host/state');
    $('#login').classList.add('hidden'); $('#dash').classList.remove('hidden');
    if (!es) connect();
    render();
  } catch (e) {
    if (e.status === 401) showLogin(fromLogin === true ? 'Wrong password.' : '');
  }
}
function connect() {
  es = new EventSource('/api/host/events?key=' + encodeURIComponent(key));
  es.addEventListener('update', () => refresh());
}

/* --------------------------------------------------------------- render */
function render() {
  document.title = 'Host: ' + S.title;
  $('#gtitle').textContent = S.title + ' (host)';

  $('#phases').innerHTML = S.phases.map(ph =>
    `<button class="btn ${S.phase === ph ? 'primary' : ''}" data-phase="${ph}">${esc(S.phaseLabels[ph])}</button>`).join('');
  const notes = {
    lobby: 'Players are joining. Deal characters when everyone is in.',
    discussion: 'All ability buttons are locked. Everyone can read their role and talk.',
    action: 'Open abilities one player (or one character) at a time below.',
    voting: 'Players can vote. Votes show in the Votes panel.',
    ended: 'Game over. Start a new game from Setup.'
  };
  $('#phaseNote').textContent = notes[S.phase] || '';
  if (document.activeElement !== $('#ann')) $('#ann').value = S.announcement || '';

  // character picker for bulk open
  const bc = $('#bulkChar'), sig = S.characters.map(c => c.id + c.name).join('|');
  if (bc.dataset.sig !== sig) {
    const prev = bc.value;
    bc.innerHTML = S.characters.filter(c => c.abilities.length).map(c => `<option value="${esc(c.id)}">${esc(c.name)} (${esc(c.role)})</option>`).join('');
    bc.value = prev; bc.dataset.sig = sig;
  }

  $('#votesCard').classList.toggle('hidden', !(S.phase === 'voting' || S.tally.length));
  $('#tally').innerHTML = S.tally.length
    ? S.tally.map(t => `<div class="tally"><b>${esc(t.name)}</b><span>${t.voters.length}: ${esc(t.voters.join(', '))}</span></div>`).join('')
    : '<p class="muted">No votes yet.</p>';

  renderPlayers();

  $('#chars').innerHTML = S.characters.map(c =>
    `<p><b>${esc(c.name)}</b> <span class="muted">(${esc(c.role)}, ${esc(c.team)}${c.copies > 1 ? ', x' + c.copies : ''})</span><br>
     <span class="muted small">${c.abilities.length ? esc(c.abilities.map(a => a.label).join(', ')) : 'no abilities'}</span></p>`).join('');

  const fmt = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#log').innerHTML = S.log.map(l => `<div><time>${fmt(l.t)}</time>${esc(l.text)}</div>`).join('') || '<p class="muted">Nothing yet.</p>';
}

function renderPlayers() {
  const box = $('#players');
  // don't yank a dropdown away while the host is choosing from it
  if (document.activeElement && document.activeElement.tagName === 'SELECT' && box.contains(document.activeElement)) { pendingRender = true; return; }
  pendingRender = false;
  if (!S.players.length) { box.innerHTML = '<p class="muted">Nobody has joined yet. Share this page\'s address without /host.</p>'; return; }
  box.innerHTML = S.players.map(p => `
    <div class="card pc ${p.alive ? '' : 'dead'}" data-p="${esc(p.id)}">
      <div class="pc-head"><span class="dot ${p.online ? 'on' : ''}" title="${p.online ? 'connected' : 'offline'}"></span>
        <h3>${esc(p.name)}</h3>${p.team ? `<span class="muted small">${esc(p.team)}</span>` : ''}${p.rejoinOpen ? '<span class="tag armed">can rejoin</span>' : ''}</div>
      <div class="row">
        <select class="input" data-assign>
          <option value="">(no character)</option>
          ${S.characters.map(c => `<option value="${esc(c.id)}" ${c.id === p.characterId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <button class="btn sm" data-act="alive" data-on="${p.alive ? 0 : 1}" style="flex:0 0 auto">${p.alive ? 'Eliminate' : 'Revive'}</button>
      </div>
      ${S.phase === 'voting' && p.vote ? `<div class="small muted" style="margin-top:6px">Voted: ${esc(p.vote === 'abstain' ? 'abstain' : (S.players.find(q => q.id === p.vote) || {}).name)}</div>` : ''}
      ${p.abilities.map(a => `
        <div class="arow">
          <div class="lab">${esc(a.label)}
            ${a.usesLeft != null ? `<span class="muted small">(${a.usesLeft} left)</span>` : ''}
            ${a.status === 'ready' ? '<span class="tag live">live</span>' : a.enabled && a.status === 'locked' ? '<span class="tag armed">armed</span>' : ''}
          </div>
          ${a.usesLeft === 0 ? `<button class="btn sm" data-act="addUse" data-a="${esc(a.id)}">+1 use</button>` : ''}
          <button class="btn sm ${a.enabled ? 'open' : ''}" data-act="ability" data-a="${esc(a.id)}" data-on="${a.enabled ? 0 : 1}" ${p.alive ? '' : 'disabled'}>${a.enabled ? 'Close' : 'Open'}</button>
        </div>`).join('')}
      <div class="row">
        <button class="btn sm" data-act="msg">Message</button>
        <button class="btn sm" data-act="reset" title="Lets this name rejoin from a new phone">Reset device</button>
        <button class="btn sm danger" data-act="kick">Kick</button>
      </div>
    </div>`).join('');
}

/* ---------------------------------------------------------- interaction */
$('#phases').addEventListener('click', e => {
  const b = e.target.closest('[data-phase]'); if (b) act('setPhase', { phase: b.dataset.phase });
});
$('#players').addEventListener('change', e => {
  if (e.target.matches('[data-assign]')) {
    act('assign', { playerId: e.target.closest('[data-p]').dataset.p, characterId: e.target.value });
  }
});
$('#players').addEventListener('focusout', () => { if (pendingRender) setTimeout(renderPlayers, 150); });
$('#players').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const card = b.closest('[data-p]'), playerId = card.dataset.p;
  const name = card.querySelector('h3').textContent;
  switch (b.dataset.act) {
    case 'alive': act('setAlive', { playerId, alive: b.dataset.on === '1' }); break;
    case 'ability': act('ability', { playerId, abilityId: b.dataset.a, enabled: b.dataset.on === '1' }); break;
    case 'addUse': act('addUse', { playerId, abilityId: b.dataset.a }); break;
    case 'msg': { const text = prompt('Private message to ' + name + ':'); if (text) act('message', { playerId, text }); break; }
    case 'reset': if (confirm('Let ' + name + ' rejoin from a new device?')) act('resetDevice', { playerId }); break;
    case 'kick': if (confirm('Remove ' + name + ' from the game?')) act('kick', { playerId }); break;
  }
});

$('#annSend').onclick = () => act('announce', { text: $('#ann').value });
$('#annClear').onclick = () => { $('#ann').value = ''; act('announce', { text: '' }); };
$('#openAll').onclick = () => act('openAll');
$('#closeAll').onclick = () => act('closeAll');
$('#bulkOpen').onclick = () => act('openCharacter', { characterId: $('#bulkChar').value, enabled: true });
$('#bulkClose').onclick = () => act('openCharacter', { characterId: $('#bulkChar').value, enabled: false });
$('#clearVotes').onclick = () => act('clearVotes');
$('#clearLog').onclick = () => act('clearLog');
$('#deal').onclick = () => { if (confirm('Deal new random characters to everyone? This replaces current assignments.')) act('dealRandom'); };
$('#reload').onclick = () => act('reloadConfig').then(() => toast('game.json reloaded'));
$('#msgAll').onclick = () => { const text = prompt('Message to every player:'); if (text) act('message', { playerId: 'all', text }); };
$('#resetKeep').onclick = () => { if (confirm('Reset to the lobby, keep everyone who joined?')) act('resetGame', { keepPlayers: true }); };
$('#resetAll').onclick = () => { if (confirm('Delete ALL players and start fresh?')) act('resetGame', { keepPlayers: false }); };

if (key) refresh(); else showLogin();
})();
