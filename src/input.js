// Unified keyboard/mouse + gamepad (PS5 DualSense / standard mapping) input.
import { clamp } from './util.js';

const KEYMAP = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', ControlLeft: 'crouch', KeyC: 'crouch',
  KeyR: 'reload', KeyQ: 'grapple', KeyE: 'grapple', KeyF: 'melee', KeyV: 'melee',
  Digit1: 'slot1', Digit2: 'slot2', Digit3: 'slot3', Digit4: 'slot4', Digit5: 'slot5', Escape: 'pause', KeyP: 'pause', Enter: 'confirm', KeyG: 'grenade', KeyX: 'dash', AltLeft: 'dash', KeyM: 'music', KeyT: 'talk', Tab: 'score',
};
const MOUSEMAP = { 0: 'fire', 2: 'aim', 1: 'grapple', 3: 'grapple', 4: 'melee' };
// Standard gamepad mapping (DualSense): 0 cross,1 circle,2 square,3 triangle,4 L1,5 R1,6 L2,7 R2,8 create,9 options,10 L3,11 R3,12-15 dpad
const PADMAP = { 0: 'jump', 1: 'crouch', 2: 'reload', 3: 'nextWeapon', 4: 'grapple', 5: 'melee', 6: 'aim', 7: 'fire', 9: 'pause', 10: 'sprint', 11: 'grenade', 12: 'grenade', 13: 'slot5', 14: 'prevWeapon', 15: 'nextWeapon', 8: 'score', 17: 'confirm' };

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = {}; this.prev = {}; this.frameState = {};
    this.keys = {}; this.mouseBtns = {};
    this.move = { x: 0, y: 0 };
    this.look = { x: 0, y: 0 };
    this.mx = 0; this.my = 0; this.wheel = 0;
    this.mouseSens = 0.0022; this.padSensX = 3.4; this.padSensY = 2.6;
    this.usingGamepad = false; this.gamepadIndex = -1; this.padHoldTime = 0;
    this.pointerLocked = false; this.anyInput = false; this.lastPadButtons = [];
    this.onLockChange = null; this.onAnyInput = null; this.lastActive = performance.now();
    this.invertY = false; this.onDeviceChange = null;
    // Mobile controls feed the existing input state; physics/player code is untouched.
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    this.touchActions = {}; this.touchMove = { x: 0, y: 0 }; this.touchLook = { x: 0, y: 0 };
    this._joyId = null; this._lookId = null; this._joyCenter = { x: 0, y: 0 }; this._lookLast = { x: 0, y: 0 };
    if (this.isTouch) this._initTouchControls();

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.lastActive = performance.now(); const a = KEYMAP[e.code]; if (a) { this.keys[a] = true; if (this.usingGamepad && this.onDeviceChange) this.onDeviceChange(false); this.usingGamepad = false; }
      if (!e.shiftKey) this.keys.sprint = false;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.anyInput = true;
    });
    window.addEventListener('keyup', (e) => { const a = KEYMAP[e.code]; if (a) this.keys[a] = false; if (!e.shiftKey) this.keys.sprint = false; });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.keys = {}; this.mouseBtns = {}; this.touchActions = {}; this.touchMove.x = this.touchMove.y = 0; } });
    window.addEventListener('blur', () => { this.keys = {}; this.mouseBtns = {}; this.touchActions = {}; this.touchMove.x = this.touchMove.y = 0; });
    this.padState = {}; this.padPrev = {};
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      let dx = e.movementX, dy = e.movementY;
      // guard against pointer-lock spikes
      if (Math.abs(dx) > 400) dx = 0; if (Math.abs(dy) > 400) dy = 0;
      this.mx += dx; this.my += dy; this.usingGamepad = false; this.lastActive = performance.now();
    });
    document.addEventListener('mousedown', (e) => {
      const a = MOUSEMAP[e.button]; if (a) this.mouseBtns[a] = true;
      if (this.usingGamepad && this.onDeviceChange) this.onDeviceChange(false);
      this.usingGamepad = false; this.anyInput = true; this.lastActive = performance.now();
      if (e.button === 1 || e.button === 3 || e.button === 4) e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => { const a = MOUSEMAP[e.button]; if (a) this.mouseBtns[a] = false; });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    });
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
  }

  _initTouchControls() {
    const root = document.getElementById('hud') || document.body;
    const wrap = document.createElement('div'); wrap.id = 'mobileControls';
    wrap.innerHTML = `
      <div class="mc-joystick"><div class="mc-stick"></div></div><div class="mc-look"></div>
      <div class="mc-actions">
        <button data-act="fire" class="mc-fire">FIRE</button><button data-act="aim">AIM</button>
        <button data-act="jump">JUMP</button><button data-act="crouch">SLIDE<br>/ DASH</button>
        <button data-act="grapple">GRAPPLE</button><button data-act="melee">SLASH</button>
        <button data-act="reload">RELOAD</button><button data-act="grenade">GRENADE</button>
        <button data-act="focus" class="mc-focus">FOCUS</button><button data-act="nextWeapon">NEXT</button>
        <button data-act="prevWeapon">PREV</button><button data-act="sprint">SPRINT</button>
      </div>`;
    root.appendChild(wrap);
    const style=document.createElement('style'); style.textContent=`
      #mobileControls{display:none;position:fixed;inset:0;z-index:50;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none;font-family:system-ui,sans-serif}
      #mobileControls *{box-sizing:border-box} #mobileControls button{pointer-events:auto;touch-action:none;width:58px;height:58px;border:1.5px solid rgba(255,255,255,.72);border-radius:50%;background:rgba(20,25,35,.42);color:#fff;font-weight:800;font-size:10px;line-height:1.05;text-shadow:0 1px 2px #000;-webkit-tap-highlight-color:transparent}
      #mobileControls button.active{background:rgba(255,255,255,.28);transform:scale(.95)} #mobileControls .mc-fire{width:72px;height:72px;background:rgba(180,40,40,.48);font-size:12px} #mobileControls .mc-focus{background:rgba(130,80,190,.48)}
      .mc-joystick{position:absolute;left:22px;bottom:28px;width:128px;height:128px;border-radius:50%;border:2px solid rgba(255,255,255,.38);background:rgba(30,35,45,.22);pointer-events:auto;touch-action:none}
      .mc-stick{position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px;border-radius:50%;background:rgba(255,255,255,.35);border:2px solid rgba(255,255,255,.72);pointer-events:none}
      .mc-look{position:absolute;left:43%;top:0;width:57%;height:100%;pointer-events:auto;touch-action:none}
      .mc-actions{position:absolute;right:16px;bottom:20px;width:210px;height:300px;pointer-events:none}.mc-actions button{position:absolute}
      .mc-actions [data-act="fire"]{right:0;bottom:92px}.mc-actions [data-act="aim"]{right:78px;bottom:132px}.mc-actions [data-act="jump"]{right:80px;bottom:54px}.mc-actions [data-act="crouch"]{right:0;bottom:20px}
      .mc-actions [data-act="grapple"]{right:154px;bottom:105px}.mc-actions [data-act="melee"]{right:148px;bottom:34px}.mc-actions [data-act="reload"]{right:86px;bottom:188px}.mc-actions [data-act="grenade"]{right:18px;bottom:188px}
      .mc-actions [data-act="focus"]{right:0;bottom:176px}.mc-actions [data-act="nextWeapon"]{right:86px;bottom:246px}.mc-actions [data-act="prevWeapon"]{right:154px;bottom:198px}.mc-actions [data-act="sprint"]{left:0;bottom:20px}
      @media (max-width:700px) and (pointer:coarse){#mobileControls{display:block}}
    `; document.head.appendChild(style);
    const setAction=(act,down)=>{if(act==='focus'){this.touchActions.aim=down;this.touchActions.fire=down}else this.touchActions[act]=down;this.anyInput=true;this.lastActive=performance.now()};
    wrap.querySelectorAll('button[data-act]').forEach(btn=>{const end=e=>{e.preventDefault();btn.classList.remove('active');setAction(btn.dataset.act,false)};btn.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;e.preventDefault();btn.setPointerCapture?.(e.pointerId);btn.classList.add('active');setAction(btn.dataset.act,true)},{passive:false});btn.addEventListener('pointerup',end,{passive:false});btn.addEventListener('pointercancel',end,{passive:false});btn.addEventListener('lostpointercapture',end,{passive:false})});
    const joy=wrap.querySelector('.mc-joystick'),stick=wrap.querySelector('.mc-stick'),radius=46;
    const updateJoy=(x,y)=>{let dx=x-this._joyCenter.x,dy=y-this._joyCenter.y,d=Math.hypot(dx,dy),k=d>radius?radius/d:1;this.touchMove.x=Math.max(-1,Math.min(1,dx*k/radius));this.touchMove.y=Math.max(-1,Math.min(1,-dy*k/radius));stick.style.transform=`translate(${dx*k}px,${dy*k}px)`;this.lastActive=performance.now()};
    const resetJoy=()=>{this._joyId=null;this.touchMove.x=0;this.touchMove.y=0;stick.style.transform=''};
    joy.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;e.preventDefault();this._joyId=e.pointerId;const r=joy.getBoundingClientRect();this._joyCenter.x=r.left+r.width/2;this._joyCenter.y=r.top+r.height/2;joy.setPointerCapture?.(e.pointerId);updateJoy(e.clientX,e.clientY)},{passive:false});
    joy.addEventListener('pointermove',e=>{if(e.pointerId===this._joyId){e.preventDefault();updateJoy(e.clientX,e.clientY)}},{passive:false}); ['pointerup','pointercancel','lostpointercapture'].forEach(ev=>joy.addEventListener(ev,e=>{if(e.pointerId===this._joyId)resetJoy()},{passive:false}));
    const look=wrap.querySelector('.mc-look');
    look.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;e.preventDefault();this._lookId=e.pointerId;this._lookLast.x=e.clientX;this._lookLast.y=e.clientY;look.setPointerCapture?.(e.pointerId)},{passive:false});
    look.addEventListener('pointermove',e=>{if(e.pointerId!==this._lookId)return;e.preventDefault();this.touchLook.x+=e.clientX-this._lookLast.x;this.touchLook.y+=e.clientY-this._lookLast.y;this._lookLast.x=e.clientX;this._lookLast.y=e.clientY;this.lastActive=performance.now()},{passive:false});
    ['pointerup','pointercancel','lostpointercapture'].forEach(ev=>look.addEventListener(ev,e=>{if(e.pointerId===this._lookId)this._lookId=null},{passive:false}));
  }

  // browsers refuse a new pointer lock for about a second after Esc released the last one, so a
  // failed request is retried until it takes or the game stops wanting it
  requestLock() {
    if (this.isTouch) return;
    this.wantLock = true; if (this.pointerLocked) return;
    const attempt = (opts) => { try { const p = this.canvas.requestPointerLock(opts); return p && p.catch ? p : Promise.resolve(); } catch (err) { return Promise.reject(err); } };
    attempt({ unadjustedMovement: true }).catch(() => attempt()).catch(() => {
      clearTimeout(this._lockRetry); this._lockRetry = setTimeout(() => { if (this.wantLock && !this.pointerLocked) this.requestLock(); }, 1200);
    });
  }
  exitLock() { this.wantLock = false; clearTimeout(this._lockRetry); if (document.pointerLockElement) document.exitPointerLock(); }

  _getPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.gamepadIndex >= 0 && pads[this.gamepadIndex]) return pads[this.gamepadIndex];
    for (const p of pads) if (p && p.connected) { this.gamepadIndex = p.index; return p; }
    return null;
  }

  update(dt) {
    // rotate button states
    this.prev = this.state; this.state = {};
    const s = this.state;
    for (const k in this.keys) if (this.keys[k]) s[k] = true;
    for (const k in this.mouseBtns) if (this.mouseBtns[k]) s[k] = true;
    for (const k in this.touchActions) if (this.touchActions[k]) s[k] = true;
    if (this.wheel > 0) s.nextWeapon = true; else if (this.wheel < 0) s.prevWeapon = true; this.wheel = 0;

    // movement from keys
    let mx = (s.right ? 1 : 0) - (s.left ? 1 : 0);
    let my = (s.forward ? 1 : 0) - (s.back ? 1 : 0);
    // look from mouse
    let lx = -this.mx * this.mouseSens, ly = -this.my * this.mouseSens; this.mx = 0; this.my = 0;

    const pad = this._getPad(); const padS = {};
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      const ax = dz(pad.axes[0] || 0), ay = dz(pad.axes[1] || 0), rx = dz(pad.axes[2] || 0), ry = dz(pad.axes[3] || 0);
      let padActive = false;
      if (Math.abs(ax) > 0 || Math.abs(ay) > 0) { mx = ax; my = -ay; padActive = true; }
      if (Math.abs(rx) > 0 || Math.abs(ry) > 0) {
        padActive = true;
        const mag = Math.hypot(rx, ry);
        if (mag > 0.94) this.padHoldTime += dt; else this.padHoldTime = 0;
        const accel = 1 + clamp((this.padHoldTime - 0.25) / 0.6, 0, 1) * 0.9;
        const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.8);
        lx += -curve(rx) * this.padSensX * accel * dt;
        ly += -curve(ry) * this.padSensY * accel * dt;
      } else this.padHoldTime = 0;
      for (const idx in PADMAP) {
        const b = pad.buttons[idx]; if (!b) continue;
        const pressed = b.pressed || b.value > 0.35;
        if (pressed) { s[PADMAP[idx]] = true; padS[PADMAP[idx]] = true; padActive = true; }
      }
      if (padActive) { if (!this.usingGamepad && this.onDeviceChange) this.onDeviceChange(true); this.usingGamepad = true; this.anyInput = true; this.lastActive = performance.now(); }
      this._pad = pad;
    } else this._pad = null;
    this.padPrev = this.padState; this.padState = padS;

    if (this.isTouch) { mx=this.touchMove.x; my=this.touchMove.y; lx += -this.touchLook.x*this.mouseSens*1.55; ly += -this.touchLook.y*this.mouseSens*1.55; this.touchLook.x=0; this.touchLook.y=0; }
    const ml = Math.hypot(mx, my); if (ml > 1) { mx /= ml; my /= ml; }
    this.move.x = mx; this.move.y = my;
    this.look.x = lx; this.look.y = this.invertY ? -ly : ly;
  }

  down(a) { return !!this.state[a]; }
  get idleSeconds() { return (performance.now() - this.lastActive) / 1000; }
  pressed(a) { return (!!this.state[a] && !this.prev[a]) || (!!this.padState[a] && !this.padPrev[a]); }
  released(a) { return !this.state[a] && !!this.prev[a]; }
  consume(a) { this.state[a] = false; }
  anyPressed() { for (const k in this.state) if (this.state[k] && !this.prev[k]) return true; return false; }

  rumble(strong = 0.5, weak = 0.5, ms = 80) {
    const pad = this._pad; if (!pad) return;
    const act = pad.vibrationActuator || (pad.hapticActuators && pad.hapticActuators[0]);
    if (!act || !act.playEffect) return;
    try { act.playEffect('dual-rumble', { duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) }); } catch (e) { /* ignore */ }
  }
}
