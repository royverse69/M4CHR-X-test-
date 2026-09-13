// Peer-to-peer networking over WebRTC, using the public PeerJS signalling service.
// Nothing runs on a server of ours: the host player's browser is the authority, every other
// player connects straight to it. That is what lets multiplayer work from a static Vercel deploy.
//
// Lobby codes are just peer ids. A private lobby takes a random 5 letter code; a public lobby
// claims one of a handful of well-known ids (PUB0..PUB23) so quick play can find it by knocking on
// every slot at once - a directory with no directory server. A connection only counts once the
// host has answered with a welcome, so a full or closed lobby can be skipped for the next one.
//
// Two things keep the lag down. Every player also opens a direct link to every other player, so
// a shot or a death travels one hop instead of bouncing through the host (the host still keeps
// score and forwards for anyone a direct link could not reach). And on every link the position
// stream rides a second, unordered, no-retransmit channel: a lost packet is simply skipped
// instead of holding up everything behind it, which is what made kills show up seconds late.

// a local dev server gets its own namespace so testing can never wander into a live lobby
const LOCAL = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const PREFIX = LOCAL ? 'doodledev-' : 'doodledistrict-';
export const PUBLIC_SLOTS = 24;
const SUFFIXES = ['', '-1', '-2', '-3'];           // where a lobby can live after host changes
const JOIN_SUFFIXES = ['', '-1', '-2', '-3', '-4', '-5'];
export const PROTO = 2;                            // bumps when the wire format grows
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const makeToken = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const PEER_OPTS = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] } };
const JOIN_TIMEOUT = 14000, QUICK_TIMEOUT = 11000, SIGNAL_TIMEOUT = 12000, LINK_TIMEOUT = 12000, LINK_TRIES = 6;
const NEAR_RTT = 0.2;                              // seconds; a lobby this close counts as "nearby"

// every public id, base codes first; launched in waves so the one lobby that is there is not
// stuck behind a hundred simultaneous ICE negotiations for ids that are not
function publicIds() { const ids = []; for (const suf of SUFFIXES) for (let i = 0; i < PUBLIC_SLOTS; i++) ids.push(PREFIX + 'PUB' + i + suf); return ids; }
function launchWaves(ids, connectOne, wave = 24, gapMs = 220) {
  let i = 0; const next = () => { if (i >= ids.length) return; const end = Math.min(ids.length, i + wave); for (; i < end; i++) connectOne(ids[i]); if (i < ids.length) setTimeout(next, gapMs); }; next();
}
function peerAvailable() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }
const idFromError = (err) => { const m = /peer\s+(\S+)/.exec(String(err && err.message || '')); return m ? m[1] : null; };
const closeQuiet = (c) => { try { if (c) c.close(); } catch (e) { /* ignore */ } };

export class Net {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false; this.id = null; this.code = null; this.hostId = null;
    this.handlers = new Map(); this.connected = false; this.onPeerJoin = null; this.onPeerLeave = null; this.onDisconnect = null;
    this.maxPlayers = 10; this.accepting = true; this.hostName = ''; this.stats = { sent: 0, recv: 0 }; this.isPublic = false;
    this.token = null; this.legacyHost = false;
    // direct links to the other players (clients only), the fast lanes on every link, and who is on the old game
    this.direct = new Map(); this.pending = new Map(); this.fast = new Map(); this.legacy = new Set(); this.roster = []; this.linkTries = new Map();
    this.fastSeq = 0; this.lastSeq = new Map(); this.rtt = new Map();
  }
  get active() { return !!this.peer && this.connected; }
  get peerIds() { return [...this.conns.keys()]; }
  on(type, fn) { this.handlers.set(type, fn); }
  _emit(type, data, from) { const h = this.handlers.get(type); if (h) h(data, from); }

  _newPeer(id) {
    return new Promise((resolve, reject) => {
      if (!peerAvailable()) return reject(new Error('networking library did not load'));
      const peer = new window.Peer(id, PEER_OPTS); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; peer.destroy(); reject(new Error('signalling server timed out')); } }, SIGNAL_TIMEOUT);
      peer.on('open', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(peer); });
      peer.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); peer.destroy(); reject(err); });
    });
  }
  _setupPeer(peer) {
    this.id = peer.id; this._keepAlive(peer);
    peer.on('error', (err) => { if (err && err.type === 'peer-unavailable') { const id = idFromError(err); const c = id && this.pending.get(id); if (c) { this.pending.delete(id); closeQuiet(c); this._retryLinks(); } } });
    peer.on('connection', (conn) => (this.isHost ? this._incoming(conn) : this._incomingDirect(conn)));
  }
  _wire(conn) {
    conn.on('data', (msg) => { this.stats.recv++; if (!msg || typeof msg !== 'object') return; this._route(msg, conn.peer); });
    conn.on('close', () => this._drop(conn.peer));
    conn.on('error', () => this._drop(conn.peer));
  }
  _drop(pid) {
    if (this.leaving || !this.conns.has(pid)) return; this.conns.delete(pid); this._dropFast(pid);
    if (this.isHost) { if (this.onPeerLeave) this.onPeerLeave(pid); this.broadcast('leave', { id: pid }); }
    else if (pid === this.hostId) { this.connected = false; if (this.onDisconnect) this.onDisconnect(); }
  }
  // one message in: bookkeeping first, then the host forwards what it should, then the game hears it
  _route(msg, from) {
    if (msg.t === 'fastok') { const c = this.conns.get(from) || this.direct.get(from); if (c) this._openFast(c, from); return; }
    if (msg.t === 'hello') { this.legacy.delete(from); return; }
    if (this.isHost) {
      if (msg.to && msg.to !== this.id) { this._deliver(msg.to, msg, false); return; }
      const out = msg.relay || msg.fwd ? { t: msg.t, d: msg.d, from, s: msg.s } : null;
      if (msg.relay) { for (const pid of this.conns.keys()) if (pid !== from) this._deliver(pid, out, msg.s != null); }
      else if (Array.isArray(msg.fwd)) { for (const pid of msg.fwd) if (pid !== from && this.conns.has(pid)) this._deliver(pid, out, msg.s != null); }
    }
    this._emit(msg.t, msg.d, msg.from || from);
  }
  // fast lane if asked and open, otherwise the reliable link
  _deliver(pid, m, fast) {
    if (fast) { const ch = this.fast.get(pid); if (ch && ch.readyState === 'open') { try { ch.send(JSON.stringify(m)); return; } catch (e) { /* fall through */ } } }
    const c = this.conns.get(pid) || this.direct.get(pid); if (c && c.open) { try { c.send(m); } catch (e) { /* ignore */ } }
  }
  _keepAlive(peer) { peer.on('disconnected', () => { if (this.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } }); }

  // ---- the fast lane: a second data channel on the same connection, unordered and never retransmitted ----
  // The side that accepted the connection listens for it and says so; the other side then opens it.
  // PeerJS only cares about the first channel, so a later in-band one is ours to handle.
  _armFast(conn, pid) {
    const pc = conn.peerConnection; if (!pc) return;
    pc.ondatachannel = (ev) => { if (ev.channel && ev.channel.label === 'fast') this._wireFast(ev.channel, pid); };
    try { conn.send({ t: 'fastok' }); } catch (e) { /* ignore */ }
  }
  _openFast(conn, pid) {
    const pc = conn.peerConnection; if (!pc || this.fast.has(pid)) return;
    try { this._wireFast(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }), pid); } catch (e) { /* the reliable link still works */ }
  }
  _wireFast(ch, pid) {
    ch.binaryType = 'arraybuffer';
    ch.onopen = () => { this.fast.set(pid, ch); };
    ch.onclose = () => { if (this.fast.get(pid) === ch) this.fast.delete(pid); };
    ch.onerror = () => { if (this.fast.get(pid) === ch) this.fast.delete(pid); };
    ch.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return; this.stats.recv++;
      // packets may overtake each other on this lane: anything older than what we have is dropped
      if (msg.s != null) { const k = (msg.from || pid) + '|' + msg.t; const last = this.lastSeq.get(k); if (last != null && msg.s <= last) return; this.lastSeq.set(k, msg.s); }
      this._route(msg, pid);
    };
    if (ch.readyState === 'open') this.fast.set(pid, ch);
  }
  _dropFast(pid) { const ch = this.fast.get(pid); if (ch) { closeQuiet(ch); this.fast.delete(pid); } }

  // ---- direct links between players (clients only; the host already talks to everyone) ----
  // the game hands over the roster whenever it changes; the peer with the bigger id opens the link
  setRoster(ids, legacyIds = []) {
    this.roster = ids.slice(); for (const id of legacyIds) this.legacy.add(id);
    if (this.isHost || !this.peer || this.legacyHost || !this.connected) return;
    for (const id of ids) {
      if (id === this.id || id === this.hostId || legacyIds.includes(id)) continue;
      if (this.direct.has(id) || this.pending.has(id) || this.id <= id) continue;
      this._linkTo(id);
    }
    for (const id of [...this.direct.keys()]) if (!ids.includes(id)) this.unlink(id);
  }
  _retryLinks() { clearTimeout(this._linkTimer); this._linkTimer = setTimeout(() => { this._linkTimer = null; if (this.peer && this.connected) this.setRoster(this.roster); }, 4000); }
  _linkTo(id) {
    const tries = this.linkTries.get(id) || 0; if (tries >= LINK_TRIES) return; this.linkTries.set(id, tries + 1);
    let conn; try { conn = this.peer.connect(id, { reliable: true, serialization: 'json', metadata: { direct: true, token: this.token, v: PROTO } }); } catch (e) { this._retryLinks(); return; }
    this.pending.set(id, conn);
    const fail = () => { if (this.pending.get(id) === conn) { this.pending.delete(id); closeQuiet(conn); this._retryLinks(); } };
    const timer = setTimeout(() => { if (!conn.open) fail(); }, LINK_TIMEOUT);
    conn.on('open', () => { clearTimeout(timer); if (this.pending.get(id) !== conn) { closeQuiet(conn); return; } this.pending.delete(id); this._adoptDirect(id, conn, false); });
    conn.on('error', () => { clearTimeout(timer); fail(); });
    conn.on('close', () => { clearTimeout(timer); fail(); });
  }
  _incomingDirect(conn) {
    conn.on('open', () => {
      const md = conn.metadata || {};
      if (!md.direct || !this.connected || (this.token && md.token !== this.token)) { closeQuiet(conn); return; }
      this._adoptDirect(conn.peer, conn, true);
    });
  }
  _adoptDirect(pid, conn, accepting) {
    const old = this.direct.get(pid); if (old && old !== conn) closeQuiet(old);
    this.direct.set(pid, conn); this.linkTries.delete(pid);
    // until the other side says hello it might be running the old game, which cannot hear us here
    this.legacy.add(pid);
    conn.on('data', (msg) => { this.stats.recv++; if (msg && typeof msg === 'object') this._route(msg, pid); });
    const gone = () => { if (this.direct.get(pid) !== conn) return; this.direct.delete(pid); this._dropFast(pid); this.legacy.delete(pid); if (!this.leaving) this._retryLinks(); };
    conn.on('close', gone); conn.on('error', gone);
    try { conn.send({ t: 'hello', v: PROTO }); } catch (e) { /* ignore */ }
    if (accepting) this._armFast(conn, pid);
  }
  unlink(pid) { const p = this.pending.get(pid); if (p) { this.pending.delete(pid); closeQuiet(p); } const c = this.direct.get(pid); if (c) { this.direct.delete(pid); closeQuiet(c); } this._dropFast(pid); this.legacy.delete(pid); this.linkTries.delete(pid); }
  // how many of the others we can reach without the host
  get directCount() { let n = 0; for (const [pid, c] of this.direct) if (c.open && !this.legacy.has(pid)) n++; return n; }

  // ---- ping: the round trip WebRTC measured on the link itself ----
  async _rttOf(conn) {
    const pc = conn && conn.peerConnection; if (!pc || !pc.getStats) return null;
    try {
      const st = await pc.getStats(); let best = null;
      st.forEach((r) => { if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated) && typeof r.currentRoundTripTime === 'number') { if (best == null || r.currentRoundTripTime < best) best = r.currentRoundTripTime; } });
      return best;
    } catch (e) { return null; }
  }
  async measureRtt(pid) { const v = await this._rttOf(this.conns.get(pid) || this.direct.get(pid)); if (v != null) this.rtt.set(pid, v); return v; }
  async meanRtt() {
    const ids = [...new Set([...this.conns.keys(), ...this.direct.keys()])];
    const vals = (await Promise.all(ids.map((id) => this.measureRtt(id)))).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  // ---- lobby creation / joining ----
  async host({ isPublic = false, code = null, token = null } = {}) {
    this.leave(); this.isHost = true; this.isPublic = isPublic; this.token = token || makeToken();
    if (code) { this.code = String(code).toUpperCase(); this.peer = await this._newPeer(PREFIX + this.code); }
    else if (isPublic) {
      for (let slot = 0; slot < PUBLIC_SLOTS; slot++) {
        try { this.peer = await this._newPeer(PREFIX + 'PUB' + slot); this.code = 'PUB' + slot; break; } catch (e) { if (!(e && e.type === 'unavailable-id')) throw e; }
      }
      if (!this.peer) throw new Error('all public lobbies are busy - host a private one');
    } else {
      for (let tries = 0; tries < 3 && !this.peer; tries++) {
        this.code = makeCode();
        try { this.peer = await this._newPeer(PREFIX + this.code); } catch (e) { if (!(e && e.type === 'unavailable-id') || tries === 2) throw e; }
      }
    }
    this._setupPeer(this.peer); this.hostId = this.id; this.connected = true; this.accepting = true;
    return this.code;
  }
  // after a host change the lobby moves to the next free generation of its code
  async hostGen(base, gen, token, isPublic) {
    let lastErr = null;
    for (let g = gen; g < gen + 6; g++) {
      try { await this.host({ isPublic, code: base + '-' + g, token }); return { code: this.code, gen: g }; }
      catch (e) { lastErr = e; if (!(e && e.type === 'unavailable-id')) break; }
    }
    throw lastErr || new Error('could not take over the lobby');
  }
  // someone knocking: a quick-play probe is told how full we are and only seated once it says it is staying
  _incoming(conn) {
    conn.on('open', () => {
      const md = conn.metadata || {};
      if (md.direct) { closeQuiet(conn); return; }
      // a full lobby still says who it is, so the lobby list can show it
      if (!this.accepting || this.conns.size >= this.maxPlayers - 1) { conn.send({ t: 'refused', d: { reason: this.accepting ? 'that lobby is full' : 'that lobby is closed', code: this.aliasCode || this.code, players: this.conns.size + 1, max: this.maxPlayers, inMatch: !!this.inMatch, hostName: this.hostName, token: this.token, v: PROTO } }); setTimeout(() => closeQuiet(conn), 600); return; }
      const seat = () => { if (this.conns.has(conn.peer)) return; this.conns.set(conn.peer, conn); this._wire(conn); if (md.v >= 2) this._armFast(conn, conn.peer); if (this.onPeerJoin) this.onPeerJoin(conn.peer, md); };
      const welcome = { hostId: this.id, code: this.aliasCode || this.code, isPublic: this.isPublic, players: this.conns.size + 1, max: this.maxPlayers, inMatch: !!this.inMatch, hostName: this.hostName, token: this.token, v: PROTO };
      if (md.probe) {
        conn.send({ t: 'welcome', d: welcome, from: this.id });
        const onData = (msg) => { if (msg && msg.t === 'stay') { conn.off('data', onData); seat(); } };
        conn.on('data', onData);
      } else { conn.send({ t: 'welcome', d: welcome, from: this.id }); seat(); }
    });
  }
  // after a host transfer the lobby lives on a generation code; keep trying to open the original code
  // as a second front door so it stays the code people know
  claimAlias(code, tries = 20) {
    if (!this.isHost || this.alias || this._aliasTimer) return;
    const attempt = async () => {
      this._aliasTimer = null; if (!this.isHost || this.alias) return;
      try { const peer = await this._newPeer(PREFIX + code); if (!this.isHost) { peer.destroy(); return; } this.alias = peer; this.aliasCode = code; peer.on('connection', (conn) => this._incoming(conn)); if (this.onAlias) this.onAlias(code); }
      catch (e) { if (--tries > 0) this._aliasTimer = setTimeout(attempt, 6000); }
    };
    this._aliasTimer = setTimeout(attempt, 1500);
  }
  // join by code. A lobby that changed hosts lives on a generation code; the plain code still finds it.
  // During a host change the callers know the generations to look at and the token the lobby carries.
  async join(code, meta = {}, opts = {}) {
    this.leave(); this.isHost = false; code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('enter a lobby code');
    this.peer = await this._newPeer(null); this._setupPeer(this.peer);
    const base = code.replace(/-\d+$/, '');
    const ids = (opts.gens ? opts.gens.map((g) => base + '-' + g) : [code, ...JOIN_SUFFIXES.map((suf) => base + suf).filter((c) => c !== code)]).map((c) => PREFIX + c);
    let res; try { res = await this._knockAny(ids, { ...meta, v: PROTO }, opts.timeout || JOIN_TIMEOUT, opts.token || null); } catch (e) { this.leave(); throw e; }
    const { hostId, conn, welcome } = res; this._adopt(hostId, conn, welcome); this.code = (welcome && welcome.code) || hostId.slice(PREFIX.length); return this.code;
  }
  // try every public slot at the same time; a nearby lobby beats a far one, a fuller one beats an emptier one
  async quickJoin(meta = {}, onStatus = null) {
    this.leave(); this.isHost = false; this.peer = await this._newPeer(null); this._setupPeer(this.peer);
    if (onStatus) onStatus('looking for an open lobby…');
    const ids = publicIds();
    const offers = await new Promise((resolve) => {
      let pending = ids.length, done = false; const attempts = [], found = []; let gather = null;
      const settle = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(gather); this.peer.off('error', onErr); resolve(found); };
      const failOne = (a) => { if (a.done) return; a.done = true; pending--; if (pending <= 0) settle(); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a); } };
      this.peer.on('error', onErr);
      const timer = setTimeout(settle, QUICK_TIMEOUT);
      const probeMeta = { ...meta, probe: true, v: PROTO };
      // whatever did not answer gets closed once a winner is picked
      this._probeAttempts = attempts;
      launchWaves(ids, (hostId) => {
        if (done) return;
        let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: probeMeta }); } catch (e) { pending--; if (pending <= 0) settle(); return; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => { if (!msg || a.done) return; if (msg.t === 'welcome') { a.done = true; pending--; found.push({ conn, hostId, welcome: msg.d }); if (onStatus) onStatus(`found ${found.length} open ${found.length === 1 ? 'lobby' : 'lobbies'}…`); if (pending <= 0) settle(); else if (!gather) gather = setTimeout(settle, 1500); } else if (msg.t === 'refused') failOne(a); });
        conn.on('error', () => failOne(a)); conn.on('close', () => failOne(a));
      });
    });
    let winner = null;
    if (offers.length) {
      await Promise.race([Promise.all(offers.map(async (o) => { o.rtt = await this._rttOf(o.conn); })), new Promise((r) => setTimeout(r, 600))]);
      const near = (o) => (o.rtt != null && o.rtt <= NEAR_RTT ? 1 : 0);
      offers.sort((a, b) => near(b) - near(a) || (b.welcome.players || 0) - (a.welcome.players || 0) || (a.rtt ?? 9) - (b.rtt ?? 9));
      winner = offers[0];
    }
    for (const a of this._probeAttempts || []) if (!winner || a.conn !== winner.conn) closeQuiet(a.conn);
    this._probeAttempts = null;
    if (!winner) { this.leave(); throw new Error('no open public lobbies'); }
    winner.conn.send({ t: 'stay' });
    this._adopt(winner.hostId, winner.conn, winner.welcome); if (winner.rtt != null) this.rtt.set(winner.hostId, winner.rtt); this.code = (winner.welcome && winner.welcome.code) || winner.hostId.slice(PREFIX.length); return this.code;
  }
  // a look at every public lobby: who is hosting, how full, whether a match is on. Nothing is joined.
  async listLobbies(meta = {}, onStatus = null) {
    if (this.active) throw new Error('leave the lobby first');
    const peer = await this._newPeer(null);
    const ids = publicIds();
    const found = await new Promise((resolve) => {
      let pending = ids.length, done = false; const attempts = [], offers = []; let gather = null;
      const settle = () => { if (done) return; done = true; clearTimeout(timer); clearTimeout(gather); peer.off('error', onErr); for (const a of attempts) closeQuiet(a.conn); resolve(offers); };
      const failOne = (a) => { if (a.done) return; a.done = true; pending--; if (pending <= 0) settle(); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a); } };
      peer.on('error', onErr);
      const timer = setTimeout(settle, QUICK_TIMEOUT);
      const probeMeta = { ...meta, probe: true, v: PROTO };
      launchWaves(ids, (hostId) => {
        if (done) return;
        let conn; try { conn = peer.connect(hostId, { reliable: true, serialization: 'json', metadata: probeMeta }); } catch (e) { pending--; if (pending <= 0) settle(); return; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => { if (!msg || a.done) return; if (msg.t === 'welcome' || msg.t === 'refused') { a.done = true; pending--; const d = msg.d || {}; offers.push({ id: hostId.slice(PREFIX.length), code: d.code || hostId.slice(PREFIX.length), players: d.players || 0, max: d.max || 10, inMatch: !!d.inMatch, hostName: d.hostName || '', full: msg.t === 'refused' || (d.players || 0) >= (d.max || 10) }); if (onStatus) onStatus(`found ${offers.length}…`); if (pending <= 0) settle(); else if (!gather) gather = setTimeout(settle, 2200); } });
        conn.on('error', () => failOne(a)); conn.on('close', () => failOne(a));
      });
    });
    try { peer.destroy(); } catch (e) { /* ignore */ }
    // one lobby can answer on more than one id after a host change; keep the fuller answer per code
    const byCode = new Map(); for (const o of found) { const k = o.code.replace(/-\d+$/, ''); const prev = byCode.get(k); if (!prev || o.players > prev.players) byCode.set(k, { ...o, code: k }); }
    return [...byCode.values()].sort((a, b) => b.players - a.players);
  }
  // knock on several ids at once; the first welcome wins, a refusal or a missing lobby on every one fails.
  // With a token only the lobby that carries it counts: another lobby on a nearby code is not ours.
  _knockAny(ids, meta, timeoutMs, wantToken = null) {
    return new Promise((resolve, reject) => {
      let pending = ids.length, done = false, lastErr = null; const attempts = [];
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr); for (const a of attempts) if (!val || a.conn !== val.conn) closeQuiet(a.conn); if (val) resolve(val); else reject(err || new Error('no lobby with that code')); };
      const failOne = (a, err) => { if (a.done) return; a.done = true; if (err && !/no lobby/.test(String(err.message))) lastErr = err; pending--; if (pending <= 0) finish(lastErr || new Error('no lobby with that code')); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a, new Error('no lobby with that code')); } };
      this.peer.on('error', onErr);
      const timer = setTimeout(() => finish(new Error('no answer from that lobby')), timeoutMs);
      for (const hostId of ids) {
        let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: meta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => { if (!msg || a.done) return; if (msg.t === 'welcome') { if (wantToken && msg.d && msg.d.token !== wantToken) { failOne(a, new Error('no lobby with that code')); closeQuiet(conn); return; } a.done = true; finish(null, { hostId, conn, welcome: msg.d }); } else if (msg.t === 'refused') failOne(a, new Error(msg.d && msg.d.reason || 'the lobby turned you away')); });
        conn.on('error', (e) => failOne(a, e instanceof Error ? e : new Error('could not connect'))); conn.on('close', () => failOne(a, null));
      }
      if (pending <= 0) finish(lastErr || new Error('no lobby with that code'));
    });
  }
  _adopt(hostId, conn, welcome) {
    this.hostId = hostId; this.conns.set(hostId, conn); this.connected = true; this.isPublic = !!(welcome && welcome.isPublic);
    this.token = (welcome && welcome.token) || null; this.legacyHost = !(welcome && welcome.v >= 2); this._wire(conn);
  }
  leave() {
    // closing our own connections must not look like other people leaving
    this.leaving = true; clearTimeout(this._aliasTimer); this._aliasTimer = null; clearTimeout(this._linkTimer); this._linkTimer = null;
    if (this.alias) closeQuiet(this.alias); this.alias = null; this.aliasCode = null;
    for (const ch of this.fast.values()) closeQuiet(ch); this.fast.clear(); this.lastSeq.clear();
    for (const c of this.direct.values()) closeQuiet(c); this.direct.clear(); for (const c of this.pending.values()) closeQuiet(c); this.pending.clear(); this.legacy.clear(); this.linkTries.clear(); this.roster = []; this.rtt.clear();
    for (const c of this.conns.values()) closeQuiet(c);
    this.conns.clear(); if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
    this.peer = null; this.connected = false; this.isHost = false; this.id = null; this.code = null; this.hostId = null; this.token = null; this.legacyHost = false; this.leaving = false;
  }

  // ---- messaging ----
  // host: to everyone. client: to the host, and with relay set, to everyone: straight down the direct
  // links where they exist, through the host for anyone else. fast puts it on the lossy lane.
  send(type, data, relay = false, fast = false) {
    this.stats.sent++;
    if (this.isHost) { const m = { t: type, d: data, from: this.id }; if (fast) m.s = ++this.fastSeq; for (const pid of this.conns.keys()) this._deliver(pid, m, fast); return; }
    if (!this.hostId) return;
    const s = fast ? ++this.fastSeq : undefined;
    if (relay && !this.legacyHost) {
      const m = { t: type, d: data, from: this.id }; if (fast) m.s = s;
      const missing = [];
      for (const pid of this.roster) {
        if (pid === this.id || pid === this.hostId) continue;
        const c = this.direct.get(pid); if (c && c.open && !this.legacy.has(pid)) this._deliver(pid, m, fast); else missing.push(pid);
      }
      const toHost = { t: type, d: data }; if (fast) toHost.s = s; if (missing.length) toHost.fwd = missing;
      this._deliver(this.hostId, toHost, fast);
    } else { const m = { t: type, d: data, relay: !!relay }; if (fast) m.s = s; this._deliver(this.hostId, m, fast); }
  }
  broadcast(type, data) { this.send(type, data, true); }
  // the lossy lane: positions and tracers, where the newest packet is all that matters
  sendFast(type, data) { this.send(type, data, true, true); }
  sendTo(pid, type, data) {
    this.stats.sent++;
    if (this.isHost) { this._deliver(pid, { t: type, d: data, from: this.id }, false); return; }
    const c = this.direct.get(pid);
    if (c && c.open && !this.legacy.has(pid)) { try { c.send({ t: type, d: data, from: this.id }); return; } catch (e) { /* fall back */ } }
    this._deliver(this.hostId, { t: type, d: data, to: pid, from: this.id }, false);
  }
}
