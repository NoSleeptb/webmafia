'use strict';
/*
 * MAFIA NIGHT — tiny zero-dependency game server (Node 16+).
 *
 *   HOST_PASSWORD=secret node server.js
 *
 * Players open  http://your-server/        (phones)
 * Host opens    http://your-server/host    (laptop or phone)
 *
 * Everything about your game (characters, stories, abilities) lives in game.json.
 * This file is the engine; you usually only edit it to change game RULES.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const BIND = process.env.BIND || '127.0.0.1'; // nginx sits in front; use 0.0.0.0 to test without nginx
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'changeme';
const GAME_FILE = path.join(__dirname, 'game.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const PHASES = ['lobby', 'discussion', 'action', 'voting', 'ended'];
const DEFAULT_LABELS = {
  lobby: 'Waiting Room',
  discussion: 'Discussion',
  action: 'Night: Use Your Abilities',
  voting: 'Voting',
  ended: 'Game Over'
};

/* ------------------------------------------------------------------ config */
function loadGame() {
  const g = JSON.parse(fs.readFileSync(GAME_FILE, 'utf8'));
  if (!Array.isArray(g.characters)) throw new Error('"characters" must be a list');
  return g;
}
let game = loadGame();
const labels = () => Object.assign({}, DEFAULT_LABELS, game.phaseLabels || {});
const charById = id => (game.characters || []).find(c => c.id === id) || null;
const abilityOf = (ch, aid) => (ch && (ch.abilities || []).find(a => a.id === aid)) || null;
const teamOf = ch => (ch && game.teams && game.teams[ch.team]) || { label: (ch && ch.team) || '', color: '#888' };

/* ------------------------------------------------------------------- state */
const freshState = () => ({ phase: 'lobby', announcement: '', players: {}, log: [] });
let state = freshState();
try { state = Object.assign(freshState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { /* first run */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {}), 300);
}
function commit() { save(); broadcast(); }
function addLog(text) { state.log.push({ t: Date.now(), text }); if (state.log.length > 300) state.log.shift(); }

const newId = () => crypto.randomBytes(4).toString('hex');
const newToken = () => crypto.randomBytes(16).toString('hex');
const err = m => ({ error: m });
const allPlayers = () => Object.values(state.players);
const playerByToken = t => (t ? allPlayers().find(p => p.token === t) : null) || null;

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------------------------------------------------------- live updates (SSE) */
const playerStreams = new Map(); // playerId -> Set(res)
const hostStreams = new Set();

function sseOpen(req, res, onClose) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // tells nginx not to buffer
  });
  res.write('retry: 3000\n\n');
  req.on('close', onClose);
}
function broadcast() {
  const msg = 'event: update\ndata: 1\n\n';
  for (const set of playerStreams.values()) for (const r of set) r.write(msg);
  for (const r of hostStreams) r.write(msg);
}
setInterval(() => {
  for (const set of playerStreams.values()) for (const r of set) r.write(': ping\n\n');
  for (const r of hostStreams) r.write(': ping\n\n');
}, 25000);

/* ------------------------------------------------------------- game logic */
function assign(p, charId) {
  const ch = charId ? charById(charId) : null;
  p.characterId = ch ? ch.id : null;
  p.enabled = {};
  p.uses = {};
  if (ch) for (const a of ch.abilities || []) p.uses[a.id] = a.uses == null ? null : a.uses;
}

// dead | spent | locked (wrong phase) | waiting (host hasn't opened it) | ready
function abilityStatus(p, a) {
  const uses = p.uses[a.id];
  if (!p.alive) return 'dead';
  if (uses != null && uses <= 0) return 'spent';
  if (state.phase !== 'action') return 'locked';
  if (!p.enabled[a.id]) return 'waiting';
  return 'ready';
}

function useAbility(p, aid, targetId) {
  const ch = charById(p.characterId);
  const a = abilityOf(ch, aid);
  if (!a) return err('Unknown ability');
  const st = abilityStatus(p, a);
  if (st !== 'ready') return err('That ability is not available right now');

  const mode = a.target || 'none';
  let target = null;
  if (mode !== 'none') {
    target = state.players[targetId];
    if (!target) return err('Pick a target');
    if (target.id === p.id && !a.allowSelf) return err("You can't target yourself");
    if (mode === 'alive' && !target.alive) return err('That player is already out');
    if (mode === 'dead' && target.alive) return err('That player is still alive');
  }
  if (p.uses[a.id] != null) p.uses[a.id]--;
  if (a.autoClose !== false) p.enabled[a.id] = false; // one use per window; host re-opens if needed

  const line = `${p.name} (${ch.name}) used "${a.label}"` + (target ? ` on ${target.name}` : '');
  addLog(line);
  p.messages.push({ t: Date.now(), from: 'you', text: `You used ${a.label}` + (target ? ` on ${target.name}` : '') + '.' });
  commit();
  return { ok: true };
}

function castVote(p, targetId) {
  if (state.phase !== 'voting') return err('Voting is not open');
  if (!p.alive) return err('Eliminated players cannot vote');
  if (targetId !== 'abstain') {
    const t = state.players[targetId];
    if (!t || !t.alive) return err('Pick a living player');
  }
  p.vote = targetId;
  commit();
  return { ok: true };
}

function join(name) {
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!name) return err('Enter a name');
  const existing = allPlayers().find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.rejoinOpen) { existing.token = newToken(); existing.rejoinOpen = false; commit(); return { token: existing.token }; }
    return err('That name is taken. If that is you on a new device, ask the host to reset your device.');
  }
  if (allPlayers().length >= 40) return err('The game is full');
  const p = { id: newId(), name, token: newToken(), characterId: null, alive: true, enabled: {}, uses: {}, vote: null, messages: [], rejoinOpen: false };
  state.players[p.id] = p;
  addLog(`${name} joined`);
  commit();
  return { token: p.token };
}

/* ------------------------------------------------------------------ views */
function playerView(p) {
  const ch = charById(p.characterId);
  const team = teamOf(ch);
  return {
    title: game.title,
    rules: game.rules || '',
    phase: state.phase,
    phaseLabel: labels()[state.phase] || state.phase,
    announcement: state.announcement,
    me: { id: p.id, name: p.name, alive: p.alive },
    character: ch ? {
      name: ch.name, role: ch.role, tagline: ch.tagline,
      teamLabel: team.label, teamColor: team.color,
      personality: ch.personality, description: ch.description, story: ch.story, secrets: ch.secrets,
      extra: ch.extra || []
    } : null,
    abilities: ch ? (ch.abilities || []).map(a => ({
      id: a.id, label: a.label, description: a.description,
      target: a.target || 'none', allowSelf: !!a.allowSelf,
      usesLeft: p.uses[a.id] == null ? null : p.uses[a.id],
      status: abilityStatus(p, a)
    })) : [],
    players: allPlayers().map(q => ({ id: q.id, name: q.name, alive: q.alive })),
    messages: p.messages.slice(-20),
    voting: state.phase === 'voting' ? { myVote: p.vote || null, canVote: p.alive } : null
  };
}

function hostView() {
  const tally = {};
  for (const q of allPlayers()) if (q.vote) (tally[q.vote] = tally[q.vote] || []).push(q.name);
  return {
    title: game.title,
    phase: state.phase, phases: PHASES, phaseLabels: labels(),
    announcement: state.announcement,
    characters: (game.characters || []).map(c => ({
      id: c.id, name: c.name, role: c.role, team: c.team, copies: c.copies == null ? 1 : c.copies,
      abilities: (c.abilities || []).map(a => ({ id: a.id, label: a.label }))
    })),
    players: allPlayers().map(p => {
      const ch = charById(p.characterId);
      return {
        id: p.id, name: p.name, alive: p.alive, rejoinOpen: p.rejoinOpen,
        online: !!(playerStreams.get(p.id) && playerStreams.get(p.id).size),
        characterId: ch ? ch.id : '', characterName: ch ? ch.name : '', team: ch ? teamOf(ch).label : '',
        vote: p.vote || null,
        abilities: ch ? (ch.abilities || []).map(a => ({
          id: a.id, label: a.label, target: a.target || 'none',
          usesLeft: p.uses[a.id] == null ? null : p.uses[a.id],
          enabled: !!p.enabled[a.id], status: abilityStatus(p, a)
        })) : []
      };
    }),
    tally: Object.entries(tally).map(([target, voters]) => ({
      target, name: target === 'abstain' ? 'Abstain' : (state.players[target] ? state.players[target].name : '?'), voters
    })).sort((a, b) => b.voters.length - a.voters.length),
    log: state.log.slice(-120).reverse()
  };
}

/* ------------------------------------------------------------ host actions */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function hostAction(b) {
  const P = state.players[b.playerId];
  const needP = () => (P ? null : err('Unknown player'));
  switch (b.type) {
    case 'setPhase': {
      if (!PHASES.includes(b.phase)) return err('Bad phase');
      const prev = state.phase;
      state.phase = b.phase;
      // Leaving the action phase slams every ability shut.
      if (b.phase !== 'action') allPlayers().forEach(q => (q.enabled = {}));
      if (b.phase === 'voting' && prev !== 'voting') allPlayers().forEach(q => (q.vote = null));
      addLog('Phase: ' + labels()[b.phase]);
      break;
    }
    case 'announce':
      state.announcement = String(b.text || '').slice(0, 500);
      if (state.announcement) addLog('Announcement: ' + state.announcement);
      break;
    case 'assign': {
      if (needP()) return needP();
      if (b.characterId && !charById(b.characterId)) return err('Unknown character');
      assign(P, b.characterId || null);
      addLog(`${P.name} is now ${P.characterId ? charById(P.characterId).name : 'unassigned'}`);
      break;
    }
    case 'dealRandom': {
      const pool = [];
      for (const c of game.characters) {
        if (c.id === game.defaultCharacterId && c.copies == null) continue; // default fills leftovers
        for (let i = 0; i < (c.copies == null ? 1 : c.copies); i++) pool.push(c.id);
      }
      shuffle(pool);
      for (const q of shuffle(allPlayers().slice())) assign(q, pool.length ? pool.pop() : (game.defaultCharacterId || null));
      addLog('Characters dealt randomly');
      break;
    }
    case 'setAlive':
      if (needP()) return needP();
      P.alive = !!b.alive;
      if (!P.alive) P.enabled = {};
      addLog(`${P.name} is ${P.alive ? 'back in the game' : 'eliminated'}`);
      break;
    case 'ability': {
      if (needP()) return needP();
      const a = abilityOf(charById(P.characterId), b.abilityId);
      if (!a) return err('Unknown ability');
      P.enabled[a.id] = !!b.enabled;
      break;
    }
    case 'openCharacter': // open/close every ability for everyone playing this character
      allPlayers().filter(q => q.characterId === b.characterId && q.alive).forEach(q => {
        for (const a of (charById(q.characterId).abilities || [])) q.enabled[a.id] = !!b.enabled;
      });
      break;
    case 'openAll':
      allPlayers().filter(q => q.alive && q.characterId).forEach(q => {
        for (const a of (charById(q.characterId).abilities || [])) q.enabled[a.id] = true;
      });
      break;
    case 'closeAll':
      allPlayers().forEach(q => (q.enabled = {}));
      break;
    case 'addUse':
      if (needP()) return needP();
      P.uses[b.abilityId] = (P.uses[b.abilityId] || 0) + 1;
      break;
    case 'message': {
      const text = String(b.text || '').slice(0, 600).trim();
      if (!text) return err('Message is empty');
      const targets = b.playerId === 'all' ? allPlayers() : (P ? [P] : []);
      if (!targets.length) return err('Unknown player');
      targets.forEach(q => q.messages.push({ t: Date.now(), from: 'host', text }));
      addLog(`Message to ${b.playerId === 'all' ? 'everyone' : P.name}: ${text}`);
      break;
    }
    case 'kick':
      if (needP()) return needP();
      (playerStreams.get(P.id) || new Set()).forEach(r => r.end());
      playerStreams.delete(P.id);
      delete state.players[P.id];
      addLog(`${P.name} was removed`);
      break;
    case 'resetDevice': // lets the same name rejoin from a new phone
      if (needP()) return needP();
      P.token = null; P.rejoinOpen = true;
      (playerStreams.get(P.id) || new Set()).forEach(r => r.end());
      playerStreams.delete(P.id);
      break;
    case 'clearVotes':
      allPlayers().forEach(q => (q.vote = null));
      break;
    case 'clearLog':
      state.log = [];
      break;
    case 'reloadConfig':
      try { game = loadGame(); addLog('game.json reloaded'); }
      catch (e) { return err('game.json problem: ' + e.message); }
      break;
    case 'resetGame':
      if (b.keepPlayers) {
        allPlayers().forEach(q => { assign(q, null); q.alive = true; q.vote = null; q.messages = []; });
        state.phase = 'lobby'; state.announcement = ''; state.log = [];
      } else {
        for (const set of playerStreams.values()) set.forEach(r => r.end());
        playerStreams.clear();
        state = freshState();
      }
      addLog('Game reset');
      break;
    default:
      return err('Unknown action');
  }
  commit();
  return { ok: true };
}

/* --------------------------------------------------------------- HTTP */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) { reject(new Error('Too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const hostOk = (req, url) => safeEqual(req.headers['x-host-key'] || url.searchParams.get('key') || '', HOST_PASSWORD);

async function api(req, res, url) {
  const p = url.pathname, m = req.method;

  if (m === 'GET' && p === '/api/info') return send(res, 200, { title: game.title, rules: game.rules || '' });

  if (m === 'GET' && p === '/api/events') {
    const pl = playerByToken(url.searchParams.get('token'));
    if (!pl) return send(res, 401, { error: 'Unknown player' });
    if (!playerStreams.has(pl.id)) playerStreams.set(pl.id, new Set());
    playerStreams.get(pl.id).add(res);
    sseOpen(req, res, () => { const s = playerStreams.get(pl.id); if (s) { s.delete(res); broadcast(); } });
    return broadcast();
  }
  if (m === 'GET' && p === '/api/me') {
    const pl = playerByToken(url.searchParams.get('token'));
    return pl ? send(res, 200, playerView(pl)) : send(res, 401, { error: 'Unknown player' });
  }

  if (p.startsWith('/api/host/')) {
    if (!hostOk(req, url)) return send(res, 401, { error: 'Wrong host password' });
    if (m === 'GET' && p === '/api/host/state') return send(res, 200, hostView());
    if (m === 'GET' && p === '/api/host/events') {
      hostStreams.add(res);
      return sseOpen(req, res, () => hostStreams.delete(res));
    }
    if (m === 'POST' && p === '/api/host/action') {
      const r = hostAction(await readBody(req));
      return send(res, r.error ? 400 : 200, r);
    }
  }

  if (m === 'POST') {
    const b = await readBody(req);
    if (p === '/api/join') { const r = join(b.name); return send(res, r.error ? 400 : 200, r); }
    const pl = playerByToken(b.token);
    if (!pl) return send(res, 401, { error: 'Unknown player' });
    if (p === '/api/ability') { const r = useAbility(pl, b.abilityId, b.targetId); return send(res, r.error ? 400 : 200, r); }
    if (p === '/api/vote') { const r = castVote(pl, b.targetId); return send(res, r.error ? 400 : 200, r); }
  }
  send(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function serveStatic(req, res, p) {
  if (p === '/') p = '/index.html';
  if (p === '/host') p = '/host.html';
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(p))); } catch (e) { res.writeHead(400); return res.end(); }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) send(res, 400, { error: 'Bad request' });
  }
}).listen(PORT, BIND, () => {
  console.log(`Mafia game running on http://${BIND}:${PORT}  (host page: /host)`);
  if (HOST_PASSWORD === 'changeme') console.log('WARNING: set HOST_PASSWORD before real use!');
});
