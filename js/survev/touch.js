// Touch controls, ported from survev: client/src/ui/touch.ts (pads, aim line) and the input section of
// client/src/game.ts (turning to face your movement, firing). Only created on phones and tablets.
// survev's y axis points up and it flips y here; the trainer uses screen coordinates, so there's no flip.
(function () {
  const DEAD_ZONE = 2;
  const SENSITIVITY = 0.00001;
  const PAD_POS_BASE = 48;
  const MOVE_DETECT_MULT = 1;
  const SHOT_DETECT_MULT = 1.075;
  const TURN_COOLDOWN = 0.5;
  const PAD_SCALE_DOWN = 0.6, PAD_SCALE_POS = 0.25, PAD_ALPHA = 0.2;
  const PAD_RADIUS = 103.5;            // client/public/img/gui/pad.svg
  const LOCKED_LANDSCAPE = { x: 126, y: 100 }, LOCKED_PORTRAIT = { x: 96, y: 160 };
  const LOCKED_Y_SAFARI_LANDSCAPE = 120, LOCKED_Y_SAFARI_PORTRAIT = 240;
  // Aim line, from LineSprites in touch.ts
  const LINE_START = 3.5, LINE_STEP = 1.5, LINE_ALPHA = 0.3, LINE_DEFAULT_RANGE = 30;
  const DOT_RADIUS = 16 * (1 / 32) * 0.375;   // dot.svg's radius times the sprite scale, in world units

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const IOS = typeof navigator !== 'undefined' && /iphone|ipod/i.test(navigator.userAgent);

  class Touch {
    // opts: { moveStyle: 'anywhere'|'locked', aimStyle: 'anywhere'|'locked', aimLine: boolean }
    constructor(opts) {
      this.moveStyle = opts.moveStyle;
      this.aimStyle = opts.aimStyle;
      this.aimLine = opts.aimLine;
      this.touches = [];
      this.moveDetected = false;
      this.shotDetected = false;
      this.touchingAim = false;
      this.turnDirTicker = 0;
      this.analog = { dir: { x: 1, y: 0 }, len: 0 };
      this.aim = { dir: { x: 1, y: 0 }, len: 0 };
      this.pads = [0, 1].map(() => ({ touched: false, center: { x: 0, y: 0 }, knob: { x: 0, y: 0 } }));
      this.W = 0; this.H = 0;
    }

    start(id, x, y) { this.touches.push({ id, down: { x, y }, pos: { x, y } }); }
    move(id, x, y) { const t = this.touches.find((q) => q.id === id); if (t) { t.pos.x = x; t.pos.y = y; } }
    end(id) { this.touches = this.touches.filter((q) => q.id !== id); }

    resize(W, H) {
      if (W === this.W && H === this.H) return;
      this.W = W; this.H = H;
      const landscape = W > H;
      const base = landscape ? LOCKED_LANDSCAPE : LOCKED_PORTRAIT;
      let y = base.y;
      if (IOS) y = landscape ? LOCKED_Y_SAFARI_LANDSCAPE : LOCKED_Y_SAFARI_PORTRAIT;
      this.padScale = landscape ? 1 : 0.8;
      this.range = PAD_POS_BASE * this.padScale;
      this.leftCenter = { x: base.x, y: H - y };
      this.rightCenter = { x: W - base.x, y: H - y };
    }

    constrained(center, pos, dist) {
      if (dist <= this.range) return { x: pos.x, y: pos.y };
      const a = Math.atan2(pos.y - center.y, pos.x - center.x);
      return { x: center.x + Math.cos(a) * this.range, y: center.y + Math.sin(a) * this.range };
    }

    getMovement() {
      this.moveDetected = false;
      const pad = this.pads[0];
      pad.touched = false;
      for (const t of this.touches) {
        if (t.down.x >= this.W * 0.5) continue;
        const center = this.moveStyle === 'anywhere' ? t.down : this.leftCenter;
        const px = t.pos.x - center.x, py = t.pos.y - center.y, dist = Math.hypot(px, py);
        if (dist > DEAD_ZONE) {
          const len = (dist - DEAD_ZONE) / (this.range / MOVE_DETECT_MULT - DEAD_ZONE);
          if (len > SENSITIVITY) this.analog = { dir: { x: px / len, y: py / len }, len };
          else this.analog = { dir: this.analog.dir, len };
          this.moveDetected = true;
        }
        pad.knob = this.constrained(center, t.pos, dist);
        pad.center = { x: center.x, y: center.y };
        pad.touched = true;
        break;
      }
      if (!pad.touched) { pad.center = { ...this.leftCenter }; pad.knob = { ...this.leftCenter }; }
    }

    getAim() {
      const pad = this.pads[1];
      pad.touched = false;
      for (const t of this.touches) {
        if (t.down.x < this.W * 0.5) continue;
        const center = this.aimStyle === 'anywhere' ? t.down : this.rightCenter;
        const px = t.pos.x - center.x, py = t.pos.y - center.y, dist = Math.hypot(px, py);
        if (dist > DEAD_ZONE) {
          this.aim = { dir: dist > SENSITIVITY ? { x: px / dist, y: py / dist } : this.aim.dir, len: dist };
        } else this.aim.len = 0;
        pad.knob = this.constrained(center, t.pos, dist);
        pad.center = { x: center.x, y: center.y };
        pad.touched = true;
        break;
      }
      this.shotDetected = this.aim.len > this.range / SHOT_DETECT_MULT && pad.touched;
      this.touchingAim = pad.touched;
      if (!pad.touched) { pad.center = { ...this.rightCenter }; pad.knob = { ...this.rightCenter }; }
    }

    // One input step, in the same order as game.ts. move is null when you aren't moving, otherwise the
    // normalized direction: survev moves at full speed however far the stick is pushed.
    update(dt, W, H) {
      this.resize(W, H);
      this.getMovement();
      this.getAim();
      const touched = this.pads[1].touched;
      let aimDir = { ...this.aim.dir };
      this.turnDirTicker -= dt;
      const l = Math.hypot(this.analog.dir.x, this.analog.dir.y);
      const moveDir = l > 0.000001 ? { x: this.analog.dir.x / l, y: this.analog.dir.y / l } : { x: 1, y: 0 };
      if (this.moveDetected && !touched) {
        // keeps looking the old way until the ticker runs out, then turns to face the way you're moving
        aimDir = this.turnDirTicker < 0 ? moveDir : this.aim.dir;
        this.aim.dir = { ...aimDir };
      }
      if (touched) this.turnDirTicker = TURN_COOLDOWN;
      const moving = this.moveDetected && Math.round(clamp(this.analog.len, 0, 1) * 255) > 0;
      return { move: moving ? moveDir : null, aim: aimDir, shoot: this.shotDetected, aimLen: this.aim.len / this.range };
    }

    drawPads(g) {
      if (!this.leftCenter) return;
      this.pads.forEach((pad) => {
        g.fillStyle = `rgba(0,0,0,${PAD_ALPHA})`;
        g.beginPath(); g.arc(pad.center.x, pad.center.y, PAD_RADIUS * this.padScale * PAD_SCALE_DOWN, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(pad.knob.x, pad.knob.y, PAD_RADIUS * this.padScale * PAD_SCALE_POS, 0, Math.PI * 2); g.fill();
      });
    }

    drawAimLine(g, W, H, me, zoom, ppu) {
      if (!this.touchingAim || !this.aimLine) return;
      const d = me.activeDef;
      let range = d.kind === 'gun' ? d.barrelLength + d.bullet.distance : LINE_DEFAULT_RANGE;
      range = Math.min(range, Math.sqrt(zoom * 1.414 * zoom));
      const dots = Math.max(Math.ceil((range - LINE_START) / LINE_STEP), 0);
      g.fillStyle = `rgba(255,255,255,${LINE_ALPHA})`;
      for (let i = 0; i < dots; i++) {
        const o = LINE_START + i * LINE_STEP;
        g.beginPath();
        g.arc(W / 2 + me.dir.x * o * ppu, H / 2 + me.dir.y * o * ppu, DOT_RADIUS * ppu, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  SV.Touch = Touch;
})();
