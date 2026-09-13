// Loose props: crates, barrels, boulders and the like that get knocked around instead of
// breaking. A prop at rest is a collider like any wall. A shot, a slash or a blast lifts it out of
// the world, it tumbles under gravity against everything else, and when it stops it settles back
// in as a collider wherever it landed. Online, whoever hit it tells everyone the new motion and,
// later, where it came to rest, so every screen ends up with the crate in the same place.
import * as THREE from 'three';
import { makeBody } from './physics.js';
import { rand, clamp, TAU } from './util.js';

const _v = new THREE.Vector3(), _pre = new THREE.Vector3(), _axis = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const round90 = (a) => Math.round(a / (Math.PI / 2)) * (Math.PI / 2);

export class Props {
  constructor(ctx) { this.ctx = ctx; this.list = []; this.onKick = null; this.onRest = null; this.thudT = 0; }
  // wrap whatever the level built: every prop starts at rest where the map put it
  attach(level) {
    const defs = level.props || []; this.list = [];
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const p = { id: i, def: d, group: d.group, half: d.half, mass: d.mass || 1, snap: d.snap || 'cube', kind: d.kind, ink: d.ink, radius: d.radius || Math.max(d.half.x, d.half.z),
        body: makeBody(new THREE.Vector3(d.start.x, d.start.y, d.start.z), d.footHalf || Math.min(d.half.x, d.half.z), d.half.y * 2, 0),
        rot: new THREE.Quaternion(), ang: new THREE.Vector3(), rest: false, box: null, seq: 0, mine: false, restT: 0, lostT: 0, snapQ: null };
      p.body.noSnap = true;
      this.list.push(p); this._toStart(p); this._settle(p, false);
    }
  }
  _toStart(p) { const s = p.def.start; p.body.pos.set(s.x, s.y, s.z); p.body.vel.set(0, 0, 0); p.ang.set(0, 0, 0); p.rot.setFromAxisAngle(UP, s.yaw || 0); p.body.onGround = true; this._sync(p); }
  // put everything back where the map drew it
  reset() { for (const p of this.list) { this._lift(p); p.seq = 0; p.mine = false; this._toStart(p); this._settle(p, false); } }
  _lift(p) { if (p.box) { this.ctx.world.removeBox(p.box); p.box = null; } p.rest = false; p.snapQ = null; p.restT = 0; }
  _extents(p) {
    // a long prop lying across its own axis swaps its footprint
    if (p.snap === 'yaw') { _e.setFromQuaternion(p.rot, 'YXZ'); const odd = Math.round(_e.y / (Math.PI / 2)) % 2 !== 0; return odd ? [p.half.z, p.half.x] : [p.half.x, p.half.z]; }
    return [p.half.x, p.half.z];
  }
  _settle(p, mine) {
    this._lift(p); p.rest = true; p.body.vel.set(0, 0, 0); p.ang.set(0, 0, 0); p.body.onGround = true;
    // ease the tumble into a square resting pose so the collider and the drawing agree
    if (p.snap === 'cube') { _e.setFromQuaternion(p.rot, 'XYZ'); _e.set(round90(_e.x), round90(_e.y), round90(_e.z)); p.snapQ = new THREE.Quaternion().setFromEuler(_e); }
    else if (p.snap === 'yaw') { _e.setFromQuaternion(p.rot, 'YXZ'); p.snapQ = new THREE.Quaternion().setFromAxisAngle(UP, round90(_e.y)); p.rot.copy(p.snapQ); }
    const [ex, ez] = this._extents(p); const b = p.body.pos;
    p.box = this.ctx.world.insertBox({ x: b.x - ex, y: b.y, z: b.z - ez }, { x: b.x + ex, y: b.y + p.half.y * 2, z: b.z + ez }, { noNav: true, prop: p });
    this._sync(p);
    if (mine && this.onRest) this.onRest(p);
  }
  _sync(p) { p.group.position.set(p.body.pos.x, p.body.pos.y + p.half.y, p.body.pos.z); p.group.quaternion.copy(p.rot); }

  // ---- being hit ----
  kick(p, impulse, mine = true) {
    this._lift(p); const b = p.body;
    b.vel.add(impulse); b.onGround = false; b.pos.y += 0.03;
    const spin = impulse.length() * 1.6 / (0.6 + p.mass);
    if (p.snap === 'yaw') p.ang.y += rand(-spin, spin); else p.ang.set(rand(-spin, spin), rand(-spin, spin), rand(-spin, spin));
    if (mine) { p.seq++; p.mine = true; if (this.onKick) this.onKick(p); }
  }
  // a bullet: a shove along its line, a little lift, a puff of ink at the hole
  hit(p, dmg, point, dir) {
    const k = dmg * 0.09 / p.mass; _v.copy(dir).multiplyScalar(k); _v.y += Math.abs(k) * 0.35 + 0.4 / p.mass;
    this.kick(p, _v);
    this.ctx.effects.strokeBurst(point, p.ink, 6, 4, { life: 0.22, size: 0.03 }); this.ctx.audio.hitEnemy(point);
  }
  // a blast: everything near it is thrown away from the centre and up
  blast(c, R) {
    const reach = R * 1.15;
    for (const p of this.list) {
      _v.set(p.body.pos.x, p.body.pos.y + p.half.y, p.body.pos.z).sub(c); const d = _v.length(); if (d > reach) continue;
      const f = 1 - d / reach, m = Math.pow(p.mass, 0.7); if (d > 0.01) _v.divideScalar(d); else _v.set(0, 1, 0);
      _v.multiplyScalar((3 + 13 * f) / m); _v.y += (3 + 8 * f) / m; this.kick(p, _v);
    }
  }
  // a blade: batting a crate across the clearing
  inArc(pos, dir, range, cosHalf) {
    const out = [];
    for (const p of this.list) { _v.set(p.body.pos.x, p.body.pos.y + p.half.y, p.body.pos.z).sub(pos); const d = _v.length(); if (d > range + p.radius) continue; if (d > 0.4 && _v.divideScalar(d).dot(dir) < cosHalf) continue; out.push(p); }
    return out;
  }
  bat(p, dir) { const m = Math.sqrt(p.mass); _v.copy(dir).multiplyScalar(9 / m); _v.y += 4 / m; this.kick(p, _v); this.ctx.effects.strokeBurst(p.group.position, p.ink, 8, 5, { life: 0.25, size: 0.035 }); }

  // ---- what the others are told ----
  pack(p) { const b = p.body; return { i: p.id, s: p.seq, p: [+b.pos.x.toFixed(2), +b.pos.y.toFixed(2), +b.pos.z.toFixed(2)], v: [+b.vel.x.toFixed(2), +b.vel.y.toFixed(2), +b.vel.z.toFixed(2)], a: [+p.ang.x.toFixed(2), +p.ang.y.toFixed(2), +p.ang.z.toFixed(2)], q: p.rot.toArray().map((x) => +x.toFixed(3)) }; }
  applyKick(d) {
    const p = this.list[d.i]; if (!p || d.s < p.seq) return; p.seq = d.s; p.mine = false;
    this._lift(p); p.body.pos.fromArray(d.p); p.body.vel.fromArray(d.v); p.ang.fromArray(d.a); p.rot.fromArray(d.q); p.body.onGround = false; this._sync(p);
  }
  applyRest(d) {
    const p = this.list[d.i]; if (!p || d.s < p.seq) return; p.seq = d.s; p.mine = false;
    this._lift(p); p.body.pos.fromArray(d.p); p.rot.fromArray(d.q); this._settle(p, false);
  }
  // for a late joiner: only the props that have moved from where the map put them
  state() { const out = []; for (const p of this.list) { const s = p.def.start, b = p.body.pos; if (p.rest && Math.abs(b.x - s.x) < 0.05 && Math.abs(b.y - s.y) < 0.05 && Math.abs(b.z - s.z) < 0.05 && p.seq === 0) continue; out.push({ ...this.pack(p), r: p.rest ? 1 : 0 }); } return out; }
  applyState(list) { for (const d of list || []) { if (d.r) this.applyRest(d); else this.applyKick(d); } }

  // ---- motion ----
  update(dt) {
    const world = this.ctx.world; this.thudT -= dt;
    for (const p of this.list) {
      if (p.rest) { if (p.snapQ) { p.rot.slerp(p.snapQ, 1 - Math.exp(-14 * dt)); if (p.rot.angleTo(p.snapQ) < 0.01) { p.rot.copy(p.snapQ); p.snapQ = null; } p.group.quaternion.copy(p.rot); } continue; }
      const b = p.body; b.vel.y -= 20 * dt; b.vel.multiplyScalar(Math.max(0, 1 - 0.15 * dt)); _pre.copy(b.vel);
      world.moveBody(b, dt);
      if (b.hitWall) { const n = b.wallNormal; if (n.x) b.vel.x = -_pre.x * 0.35; if (n.z) b.vel.z = -_pre.z * 0.35; p.ang.multiplyScalar(0.7); this._thud(p, Math.abs(n.x ? _pre.x : _pre.z)); }
      if (b.hitCeiling) b.vel.y = -_pre.y * 0.25;
      if (b.onGround) {
        if (b.landVel < -4.5) { b.vel.y = -b.landVel * 0.3; b.onGround = false; this._thud(p, -b.landVel); if (p.snap !== 'free') { p.ang.x += rand(-2, 2); p.ang.z += rand(-2, 2); } }
        else { const f = Math.max(0, 1 - (p.snap === 'free' ? 1.6 : 6) * dt); b.vel.x *= f; b.vel.z *= f; if (b.landVel < -1.5) this._thud(p, -b.landVel); }
      }
      // spin: a ball rolls with the ground, everything else tumbles on what it was given
      if (p.snap === 'free' && b.onGround) { const sp = Math.hypot(b.vel.x, b.vel.z); if (sp > 0.05) { _axis.set(-b.vel.z, 0, b.vel.x).divideScalar(sp); _q.setFromAxisAngle(_axis, sp * dt / p.radius); p.rot.premultiply(_q); } }
      else {
        if (p.snap === 'yaw') { p.ang.x = 0; p.ang.z = 0; }
        const w = p.ang.length(); if (w > 1e-4) { _axis.copy(p.ang).divideScalar(w); _q.setFromAxisAngle(_axis, w * dt); p.rot.premultiply(_q); }
        if (b.onGround) p.ang.multiplyScalar(Math.max(0, 1 - 5 * dt));
      }
      // a prop that falls off the page comes back where it started
      if (b.pos.y < -30) { p.lostT += dt; if (p.lostT > 1.5) { p.lostT = 0; this._toStart(p); this._settle(p, p.mine); } continue; }
      this._sync(p);
      const still = b.onGround && b.vel.lengthSq() < 0.09 && (p.snap === 'free' ? Math.hypot(b.vel.x, b.vel.z) < 0.15 : p.ang.lengthSq() < 0.6);
      if (still) { p.restT += dt; if (p.restT > 0.3) this._settle(p, p.mine); } else p.restT = 0;
    }
  }
  _thud(p, speed) {
    if (speed < 1.5 || this.thudT > 0) return; this.thudT = 0.06;
    const pos = p.group.position; this.ctx.audio.crateLand(pos);
    if (speed > 5) this.ctx.effects.strokeBurst(pos, p.ink, 5, 3, { life: 0.2, size: 0.03 });
  }
}
