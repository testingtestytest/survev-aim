// Bot "player": drives an SV.Player with keyboard-style 8-way input like a real survev player.
// It strafes around a preferred distance, sometimes rushes into melee range, can fire back,
// and can dodge bullets it has had time to react to. How well it does all this is its skill.
(function () {
  const { rand } = SV.util;
  const DIRS = [...Array(8)].map((_, k) => ({ x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) }));
  const RUSH_GAP = { never: null, sometimes: [8, 14], often: [4, 7] };

  // Per skill level:
  //  Strafing   run: seconds before changing direction, stop: chance of standing still (an easy target),
  //             tol: how closely it sticks to moving across your line of fire (lower = stricter)
  //  Aim        shotErr: per-shot spread in degrees (std dev), react: s to adapt to your direction changes,
  //             leadErr: how far its lead wanders from perfect, track: crosshair follow rate
  //  Dodging    dodge: chance it tries to dodge a shot it has seen
  SV.BOT_SKILL = {
    low:    { run: [0.5, 1.2],  stop: 0.25, tol: 0.95, shotErr: 3.2, react: 0.32, leadErr: 0.55, track: 6,  dodge: 0.15 },
    medium: { run: [0.3, 0.8],  stop: 0.12, tol: 0.75, shotErr: 1.8, react: 0.22, leadErr: 0.3,  track: 9,  dodge: 0.4 },
    high:   { run: [0.2, 0.55], stop: 0.05, tol: 0.5,  shotErr: 0.9, react: 0.14, leadErr: 0.15, track: 14, dodge: 0.7 },
    pro:    { run: [0.12, 0.4], stop: 0.02, tol: 0.4,  shotErr: 0.5, react: 0.1,  leadErr: 0.08, track: 18, dodge: 0.95 },
  };
  const WIDE_MULT = 2.2;              // "wide" movement = longer runs in one direction
  const SPRAY_BREAK = 0.35;           // radians (~20°) off aim before it lets go of the trigger
  const BURST_CHANCE = 0.25;          // chance a trigger pull is a short burst instead of a mag dump
  const BURST_HOLD = [0.25, 0.5];     // how long a short burst holds the trigger
  const BURST_PAUSE = [0.3, 0.7];     // pause after a short burst
  const DODGE_MARGIN = 0.5;           // units of clearance beyond the hitbox that still count as a threat

  // Dynamic distance: the bot picks any distance in this range, holds loosely around it while it
  // slowly drifts, then picks another. Nothing repeats, so it doesn't settle into set radiuses.
  const DYN = {
    range: [4, 24],     // units from you
    slack: [1.5, 3],    // how far either side of the chosen distance it's happy
    stay: [1.5, 6],     // seconds before choosing again
    minJump: 3,         // a new distance is at least this far from the old one
    drift: 1.5,         // up to this many units/s of drift while holding
    afterFight: [16, 24],   // where it heads after a rush or brawl
  };
  const RUSH_GIVE_UP = [1.2, 2.2];    // s a rush lasts, plus time to cover the distance beyond the next line
  const RUSH_GIVE_UP_DIST = 12;
  const RUSH_APPROACH_SPEED = 8;      // units/s it can count on closing, as its path isn't a straight line
  const YOU_RETREAT_SPEED = 6;        // units/s away from the bot that counts as you backing off
  const YOU_RETREAT_TIME = 0.35;      // s of that before the bot stops following you
  SV.DYNAMIC_RANGE = DYN.range;
  SV.DYNAMIC_SPAWN = 14;              // a typical distance for the previews

  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  class Bot {
    // opts: { distance (units or 'dynamic'), rush, movement: 'strafe'|'wide'|'mixed', still, fire, skill,
    //         dodge, dodgeReact (s), view: () => { hw, hh } the half-size of your screen in units }
    constructor(player, target, opts) {
      this.p = player;
      this.t = target;
      this.o = opts;
      this.S = SV.BOT_SKILL[opts.skill || 'medium'];
      this.dynamic = opts.distance === 'dynamic';
      // start from where it spawned, so it doesn't walk at you straight away
      this.setGoal(Math.hypot(player.pos.x - target.pos.x, player.pos.y - target.pos.y));
      this.youBackT = 0;
      this.dodgeT = 0;
      this.dirIdx = -1;
      this.dirT = 0;
      this.mode = 'hold';                 // hold | rush | brawl
      this.modeT = 0;
      this.rushIn = this.nextRush();
      this.runStyle = opts.movement === 'wide' ? 'wide' : 'strafe';
      this.styleT = rand(2, 4);
      this.aimAng = Math.atan2(target.pos.y - player.pos.y, target.pos.x - player.pos.x);
      this.fireT = rand(0.3, 0.8);
      this.spraying = false;
      this.sprayLeft = Infinity;
      this.vEst = { x: 0, y: 0 };         // the bot's (delayed) read of your velocity
      this.lead = 1;                       // how much it leads (1 = perfect)
      this.leadT = 0;
      this.shotDecisions = new Map();     // shotId -> will it try to dodge this shot?
      this.dodges = 0;                    // stats, also used by the tests
      this.lastDodgeAge = null;
    }

    nextRush() { const g = RUSH_GAP[this.o.rush]; return g ? rand(g[0], g[1]) : Infinity; }

    // The distances it's happy at right now, as [closest, furthest].
    range() {
      if (this.mode === 'hold' && this.dynamic) return [this.goal - this.slack, this.goal + this.slack];
      const D = this.mode === 'hold' ? this.o.distance : 2.6;
      return [D * 0.75 - 0.5, D * 1.25 + 1];
    }

    setGoal(distance) {
      this.goal = Math.max(DYN.range[0], Math.min(DYN.range[1], distance));
      this.slack = rand(DYN.slack[0], DYN.slack[1]);
      this.goalDrift = rand(-DYN.drift, DYN.drift);
      this.goalT = rand(DYN.stay[0], DYN.stay[1]);
      this.dirT = 0;
    }

    nextGoal() {
      let g;
      do g = rand(DYN.range[0], DYN.range[1]); while (Math.abs(g - this.goal) < DYN.minJump);
      this.setGoal(g);
    }

    // A rush or brawl is over: it gets back out, so you aren't the only one giving ground.
    endFight() {
      this.mode = 'hold'; this.rushIn = this.nextRush(); this.dirT = 0;
      if (this.dynamic) this.setGoal(rand(DYN.afterFight[0], DYN.afterFight[1]));
    }

    // If you back away, let you: settle at the range you opened up instead of following.
    letYouGo(dist, dt) {
      const t = this.t, p = this.p, d = dist || 1;
      const vAway = ((t.pos.x - t.posOld.x) * (t.pos.x - p.pos.x) + (t.pos.y - t.posOld.y) * (t.pos.y - p.pos.y)) / d / dt;
      this.youBackT = vAway > YOU_RETREAT_SPEED ? this.youBackT + dt : 0;
      if (this.youBackT < YOU_RETREAT_TIME || dist <= this.goal + this.slack || this.goal >= DYN.range[1]) return;
      this.setGoal(dist);
      this.youBackT = 0;
    }

    // Dynamic range must not make the bot vanish: would this direction take it past the screen edge?
    leavesScreen(v) {
      const s = this.dynamic && this.mode === 'hold' && this.o.view && this.o.view();
      if (!s) return false;
      const rx = this.p.pos.x - this.t.pos.x, ry = this.p.pos.y - this.t.pos.y;
      // >= 0: once past an edge, moving along it isn't enough, it has to come back in
      return (Math.abs(rx + v.x * 2) > s.hw && v.x * rx >= 0) || (Math.abs(ry + v.y * 2) > s.hh && v.y * ry >= 0);
    }

    pickDir() {
      const p = this.p.pos, t = this.t.pos;
      const dx = p.x - t.x, dy = p.y - t.y, d = Math.hypot(dx, dy) || 1;
      const away = { x: dx / d, y: dy / d };
      const [lo, hi] = this.range();
      // A rush or a dynamic range change heads fairly straight for where it's going.
      const moveTol = this.mode === 'rush' || (this.dynamic && this.mode === 'hold') ? 0.5 : 0.75;
      let want, tol = moveTol;               // desired radial component (+ away, - toward)
      if (this.mode === 'rush') want = -0.9;
      else if (d > hi) want = -0.7;
      else if (d < lo) want = 0.7;
      else { want = 0; tol = this.S.tol; }   // in range: strafe across the line of fire
      const cands = [];
      DIRS.forEach((v, k) => {
        if (k === this.dirIdx || this.leavesScreen(v)) return;
        const r = v.x * away.x + v.y * away.y;
        if (Math.abs(r - want) < tol) cands.push(k);
      });
      if (cands.length) this.dirIdx = cands[Math.floor(Math.random() * cands.length)];
      else if (this.dynamic && this.mode === 'hold') {
        // boxed in by the screen edge: slide along it, or come back toward you if there's no way along
        const free = DIRS.map((v, k) => k).filter((k) => !this.leavesScreen(DIRS[k]));
        const score = (k) => -Math.abs(DIRS[k].x * away.x + DIRS[k].y * away.y - want);
        this.dirIdx = free.reduce((a, k) => (a < 0 || score(k) > score(a) ? k : a), -1);
      } else this.dirIdx = Math.floor(Math.random() * 8);
    }

    // Long runs can overshoot a narrow band or the screen edge, so a dynamic bot turns early.
    offCourse(dist) {
      if (!this.dynamic || this.mode !== 'hold' || this.dirIdx < 0 || this.dodgeT > 0) return false;
      const v = DIRS[this.dirIdx], [lo, hi] = this.range();
      const r = (v.x * (this.p.pos.x - this.t.pos.x) + v.y * (this.p.pos.y - this.t.pos.y)) / (dist || 1);
      return this.leavesScreen(v) || (dist > hi + 1 && r > 0.1) || (dist < lo - 1 && r < -0.1);
    }

    // React to bullets, but only once they've been in the air for the reaction time.
    checkDodge(dt) {
      const p = this.p, world = p.world;
      if (!this.o.dodge || this.o.still || !world) return;
      const react = this.o.dodgeReact == null ? 0.15 : this.o.dodgeReact;
      const vel = { x: (p.pos.x - p.posOld.x) / dt, y: (p.pos.y - p.posOld.y) / dt };
      let best = null;
      for (const b of world.bullets) {
        if (!b.alive || b.owner === p) continue;
        const age = world.time - b.born;
        if (age < react) continue;           // hasn't noticed this shot yet
        const rx = p.pos.x - b.pos.x, ry = p.pos.y - b.pos.y;
        const along = rx * b.dir.x + ry * b.dir.y;
        if (along <= 0 || along > b.distance - b.traveled + p.rad) continue;   // passed, or falls short
        const t = along / b.speed;
        const perp = { x: -b.dir.y, y: b.dir.x };
        const lateral = rx * perp.x + ry * perp.y;
        // where it'll be relative to the bullet if it keeps doing what it's doing
        const future = lateral + (vel.x * perp.x + vel.y * perp.y) * t;
        if (Math.abs(future) > p.rad + DODGE_MARGIN) continue;                 // already going to miss
        if (!best || t < best.t) best = { b, t, perp, lateral, age };
      }
      if (!best) return;
      const id = best.b.shotId;
      if (!this.shotDecisions.has(id)) {
        if (this.shotDecisions.size > 64) this.shotDecisions.clear();
        this.shotDecisions.set(id, Math.random() < this.S.dodge);
      }
      if (!this.shotDecisions.get(id)) return;

      // pick the 8-way direction that ends up furthest from the bullet's path
      const spd = p.calcSpeed();
      let bestIdx = this.dirIdx, bestLat = -1;
      DIRS.forEach((v, k) => {
        const lat = Math.abs(best.lateral + (v.x * best.perp.x + v.y * best.perp.y) * spd * best.t);
        if (lat > bestLat) { bestLat = lat; bestIdx = k; }
      });
      this.dirIdx = bestIdx;
      this.dirT = Math.max(best.t, 0.1) + rand(0, 0.08);
      this.dodgeT = this.dirT;
      this.dodges++;
      this.lastDodgeAge = best.age;
    }

    update(dt) {
      const p = this.p, t = this.t, i = p.input, S = this.S;
      if (p.dead) { i.up = i.down = i.left = i.right = false; i.shootHold = false; return; }
      const dist = Math.hypot(p.pos.x - t.pos.x, p.pos.y - t.pos.y);

      // behaviour state
      if (this.mode === 'hold' && (this.rushIn -= dt) <= 0) {
        this.mode = 'rush'; this.dirT = 0;
        this.modeT = rand(RUSH_GIVE_UP[0], RUSH_GIVE_UP[1]) + Math.max(0, dist - RUSH_GIVE_UP_DIST) / RUSH_APPROACH_SPEED;
      }
      if (this.mode === 'rush') {
        if (dist < 3) { this.mode = 'brawl'; this.modeT = rand(1.2, 2.5); this.dirT = 0; }
        else if ((this.modeT -= dt) <= 0) this.endFight();   // you got away
      }
      if (this.mode === 'brawl' && (this.modeT -= dt) <= 0) this.endFight();
      if (this.dynamic && this.mode === 'hold') {
        this.goal = Math.max(DYN.range[0], Math.min(DYN.range[1], this.goal + this.goalDrift * dt));
        if ((this.goalT -= dt) <= 0) this.nextGoal();
        this.letYouGo(dist, dt);
      }
      if (this.o.movement === 'mixed' && (this.styleT -= dt) <= 0) {
        this.runStyle = this.runStyle === 'strafe' ? 'wide' : 'strafe';
        this.styleT = rand(2, 4);
      }

      // 8-way movement, re-picked at random intervals with short stops; a dodge takes over for a moment
      this.dodgeT -= dt;
      this.checkDodge(dt);
      if (this.offCourse(dist)) this.dirT = 0;
      if (this.o.still) { this.dirIdx = -1; }
      else if ((this.dirT -= dt) <= 0) {
        if (this.mode !== 'rush' && Math.random() < S.stop) { this.dirIdx = -1; this.dirT = rand(0.15, 0.35); }
        else {
          this.pickDir();
          const m = this.runStyle === 'wide' ? WIDE_MULT : 1;
          this.dirT = this.mode === 'rush' ? rand(0.2, 0.4) : rand(S.run[0] * m, S.run[1] * m);
        }
      }
      const v = this.dirIdx >= 0 ? DIRS[this.dirIdx] : { x: 0, y: 0 };
      i.right = v.x > 0.3; i.left = v.x < -0.3; i.down = v.y > 0.3; i.up = v.y < -0.3;

      // ---- aim: predict where you'll be when the bullet arrives ----
      // your actual velocity this tick; the bot only adapts to it after its reaction time
      const vx = (t.pos.x - t.posOld.x) / dt, vy = (t.pos.y - t.posOld.y) / dt;
      const k = Math.min(1, dt / S.react);
      this.vEst.x += (vx - this.vEst.x) * k;
      this.vEst.y += (vy - this.vEst.y) * k;
      // lead factor wanders a bit (sometimes under-leads, sometimes over-leads)
      if ((this.leadT -= dt) <= 0) {
        this.lead = 1 + (Math.random() * 2 - 1.3) * S.leadErr;
        this.leadT = rand(0.5, 1.4);
      }
      const d = p.activeDef;
      const bulletSpeed = d.kind === 'gun' ? d.bullet.speed : Infinity;
      let ax = t.pos.x, ay = t.pos.y;
      for (let it = 0; it < 2; it++) {               // iterate intercept time
        const tt = Math.hypot(ax - p.pos.x, ay - p.pos.y) / bulletSpeed;
        ax = t.pos.x + this.vEst.x * tt * this.lead;
        ay = t.pos.y + this.vEst.y * tt * this.lead;
      }
      const want = Math.atan2(ay - p.pos.y, ax - p.pos.x);
      let diff = want - this.aimAng;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.aimAng += diff * Math.min(1, S.track * dt);
      p.dir = { x: Math.cos(this.aimAng), y: Math.sin(this.aimAng) };

      // ---- shooting ----
      i.shootHold = false;
      if (this.o.fire && !t.dead) {
        const inRange = d.kind === 'gun' ? dist < d.bullet.distance * 0.9 : dist < 3;
        const onTarget = Math.abs(diff) < Math.max(0.05, Math.atan2(t.rad * 1.5, dist));
        const isAuto = d.kind === 'gun' && (d.fireMode === 'auto' || d.fireMode === 'burst');
        const hasAmmo = d.kind !== 'gun' || p.slots[p.cur].ammo > 0;
        // Automatic guns are mostly mag dumped: once it starts, it keeps the trigger held until the
        // mag is empty, you're out of range or its aim is way off. Sometimes it's just a short burst.
        if (this.spraying) {
          if (!inRange || !hasAmmo || Math.abs(diff) > SPRAY_BREAK) this.spraying = false;
          else if ((this.sprayLeft -= dt) <= 0) { this.spraying = false; this.fireT = rand(BURST_PAUSE[0], BURST_PAUSE[1]); }
        }
        if (this.spraying || (inRange && onTarget && (this.fireT -= dt) <= 0)) {
          // small per-shot hand error
          const err = (gauss() * S.shotErr * Math.PI) / 180;
          p.dir = { x: Math.cos(this.aimAng + err), y: Math.sin(this.aimAng + err) };
          if (isAuto) {
            if (!this.spraying && hasAmmo) {
              this.spraying = true;
              this.sprayLeft = Math.random() < BURST_CHANCE ? rand(BURST_HOLD[0], BURST_HOLD[1]) : Infinity;
            }
            i.shootHold = true;
          } else if (p.slots[p.cur].cooldown < 0) { i.shootStart = true; this.fireT = rand(0.05, 0.25); }
        }
        if (d.kind === 'gun' && p.slots[p.cur].ammo === 0) p.tryReload();
      }
    }
  }

  SV.Bot = Bot;
})();
