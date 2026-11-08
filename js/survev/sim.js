// Survev-faithful simulation, ported from survev's server code (github.com/survev/survev, GPL-3.0):
//   server/src/game/weaponManager.ts  -> switching, free switch, fire modes, spread, reload, melee
//   server/src/game/objects/player.ts -> movement, recalculateSpeed, damage + armor + headshots
//   server/src/game/objects/bullet.ts -> bullet distance jitter, falloff
// World units: player radius = 1. Coordinates here are y-down (screen style); survev is y-up,
// which only mirrors left/right offsets and doesn't change any timing or damage.
(function () {
  const SV = window.SV;
  const C = SV.CONFIG;
  const DEG = Math.PI / 180;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const remap = (v, a, b, x, y) => x + ((v - a) / (b - a)) * (y - x);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rotate = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });
  SV.util = { rand, randInt, remap, clamp, rotate, DEG };

  Object.values(SV.GUNS).forEach((g) => (g.kind = 'gun'));
  Object.values(SV.MELEE).forEach((m) => (m.kind = 'melee'));
  // client/src/objects/particles.ts bloodSplat
  SV.BLOOD = {
    life: 0.5, drag: 1, images: ['part-splat-01', 'part-splat-02', 'part-splat-03'],
    scaleStart: 0.04, scaleEnd: [0.15, 0.2], fadeFrom: [0.75, 1], value: [0.45, 0.8], bulletRot: 1, meleeSpread: Math.PI / 3,
  };
  // ---------- obstacles: rocks and trees ----------
  // server/src/game/objects/obstacle.ts and shared/defs/mapObjects/obstacles/mapObstacleDefs.ts.
  class Obstacle {
    constructor(kind, x, y) {
      const d = SV.OBSTACLE_DEFS[kind];
      this.kind = kind; this.def = d; this.x = x; this.y = y;
      this.maxScale = rand(d.scale.createMin, d.scale.createMax);
      this.minScale = this.maxScale * d.scale.destroy;
      this.scale = this.maxScale;
      this.health = this.maxHealth = d.health;
      this.height = d.height;
      this.dead = false;
      this.rot = randInt(0, 3) * Math.PI / 2;      // map.ts: a random quarter turn
    }
    get r() { return this.def.rad * this.scale; }
    // obstacle.damage: shrinks with health, and only a wreck is left at zero
    damage(amount) {
      if (this.dead) return;
      this.health = Math.max(0, this.health - amount);
      const t = clamp(this.health / this.maxHealth, 0, 1);
      this.scale = this.minScale + (this.maxScale - this.minScale) * t;
      if (this.health <= 0) { this.dead = true; this.scale = this.minScale; }
    }
  }

  const CHUNK = 32;              // units per side; obstacles are placed a chunk at a time as you explore
  const PASS_GAP = 3.6;          // room left between obstacles so a player fits (this trainer's rule; the game only stops overlaps)
  const SPAWN_CLEAR = 5;         // nothing grows right on the starting point
  const PATH_RANGE = 44;         // furthest a single path plan looks
  const PATH_PAD = 12;           // room around the straight line for going around things
  const PATH_ARRIVE = 2.5;       // close enough to the goal
  const DIAG = Math.SQRT2;

  // An endless field at the game's density: count = density * area / 250000 (map.ts genDensitySpawn).
  class ObstacleField {
    constructor(mult) { this.mult = mult; this.chunks = new Map(); }
    chunk(cx, cy) {
      const key = cx + ',' + cy;
      let list = this.chunks.get(key);
      if (!list) { list = []; this.chunks.set(key, list); this.fill(cx, cy, list); }
      return list;
    }
    fill(cx, cy, list) {
      const existing = [];
      for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) {
        const other = this.chunks.get(i + ',' + j);
        if (other && other !== list) existing.push(...other);
      }
      for (const kind of Object.keys(SV.OBSTACLE_DEFS)) {
        const d = SV.OBSTACLE_DEFS[kind], want = (d.density / d.densityArea) * CHUNK * CHUNK * this.mult;
        const count = Math.floor(want + Math.random());
        for (let n = 0; n < count; n++) {
          for (let tries = 0; tries < 8; tries++) {
            const o = new Obstacle(kind, (cx + Math.random()) * CHUNK, (cy + Math.random()) * CHUNK);
            const clear = (q) => Math.hypot(q.x - o.x, q.y - o.y) >= q.r + o.r + PASS_GAP;
            if (Math.hypot(o.x, o.y) < o.r + SPAWN_CLEAR || !existing.every(clear) || !list.every(clear)) continue;
            list.push(o);
            break;
          }
        }
      }
    }
    near(x, y, r) {
      const out = [];
      const x0 = Math.floor((x - r) / CHUNK), x1 = Math.floor((x + r) / CHUNK), y0 = Math.floor((y - r) / CHUNK), y1 = Math.floor((y + r) / CHUNK);
      for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) out.push(...this.chunk(i, j));
      return out;
    }
    isFree(x, y, r) { return this.near(x, y, r + 3).every((o) => o.dead || Math.hypot(o.x - x, o.y - y) >= o.r + r); }
    // Does a live obstacle, grown by extra, cross this line?
    blocked(a, b, extra = 0) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (const o of this.near((a.x + b.x) / 2, (a.y + b.y) / 2, len / 2 + 3 + extra)) {
        if (!o.dead && segCircle(a.x, a.y, b.x, b.y, o.x, o.y, o.r + extra) != null) return true;
      }
      return false;
    }
    // Would moving along dir run into something soon? Moving away from what you're touching doesn't count.
    ahead(pos, dir, look, rad) {
      for (const o of this.near(pos.x, pos.y, look + rad + 3)) {
        if (o.dead) continue;
        const rx = o.x - pos.x, ry = o.y - pos.y, along = rx * dir.x + ry * dir.y, reach = o.r + rad;
        if (along <= 0 || along > look + reach) continue;
        if (Math.abs(rx * dir.y - ry * dir.x) < reach) return true;
      }
      return false;
    }
    // A* on a 1-unit grid with 8-way moves, the same moves a player's keys make. Cells are off limits within
    // rad + clear of an obstacle, except that right beside the start only real contact counts, so a bot
    // hugging a tree can still leave. If the goal can't be reached it goes to the closest cell it found.
    findPath(from, to, rad, clear) {
      let gx = to.x, gy = to.y;
      const L = Math.hypot(gx - from.x, gy - from.y);
      if (L > PATH_RANGE) { gx = from.x + ((gx - from.x) / L) * PATH_RANGE; gy = from.y + ((gy - from.y) / L) * PATH_RANGE; }
      const ox = Math.floor(Math.min(from.x, gx) - PATH_PAD), oy = Math.floor(Math.min(from.y, gy) - PATH_PAD);
      const w = Math.ceil(Math.abs(gx - from.x)) + 2 * PATH_PAD + 2, h = Math.ceil(Math.abs(gy - from.y)) + 2 * PATH_PAD + 2, n = w * h;
      const wall = new Uint8Array(n), cost = new Float32Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
      for (const o of this.near(ox + w / 2, oy + h / 2, Math.hypot(w, h) / 2 + 3)) {
        if (o.dead) continue;
        const R = o.r + rad + clear, x0 = Math.max(0, Math.floor(o.x - R - ox)), x1 = Math.min(w - 1, Math.ceil(o.x + R - ox));
        const y0 = Math.max(0, Math.floor(o.y - R - oy)), y1 = Math.min(h - 1, Math.ceil(o.y + R - oy));
        for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
          const cx = ox + i + 0.5, cy = oy + j + 0.5, d = Math.hypot(cx - o.x, cy - o.y);
          const limit = Math.hypot(cx - from.x, cy - from.y) < 2 ? o.r + rad - 0.05 : R;
          if (d < limit) wall[j * w + i] = 1;
        }
      }
      const guess = (c) => {
        const dx = Math.abs(ox + (c % w) + 0.5 - gx), dy = Math.abs(oy + Math.floor(c / w) + 0.5 - gy);
        return Math.max(dx, dy) + (DIAG - 1) * Math.min(dx, dy);
      };
      const start = Math.floor(from.y - oy) * w + Math.floor(from.x - ox);
      const heap = [[guess(start), start]];
      const push = (e) => { let i = heap.push(e) - 1; while (i) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
      const pop = () => {
        const top = heap[0], last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          for (let i = 0; ;) {
            let m = i; const a = 2 * i + 1, b = a + 1;
            if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
            if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
          }
        }
        return top;
      };
      cost[start] = 0;
      let best = start, bestH = guess(start);
      while (heap.length) {
        const c = pop()[1];
        if (done[c]) continue;
        done[c] = 1;
        const here = guess(c);
        if (here < bestH) { bestH = here; best = c; }
        if (here <= PATH_ARRIVE) break;
        const cx = c % w, cy = Math.floor(c / w);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const m = ny * w + nx;
          if (wall[m] || done[m]) continue;
          if (dx && dy && (wall[cy * w + nx] || wall[ny * w + cx])) continue;   // no cutting corners
          const g = cost[c] + (dx && dy ? DIAG : 1);
          if (g < cost[m]) { cost[m] = g; prev[m] = c; push([g + guess(m), m]); }
        }
      }
      if (best === start) return null;
      const path = [];
      for (let c = best; c !== start; c = prev[c]) path.push({ x: ox + (c % w) + 0.5, y: oy + Math.floor(c / w) + 0.5 });
      return path.reverse();
    }
  }
  SV.ObstacleField = ObstacleField;

  SV.defOf = (type) => SV.GUNS[type] || SV.MELEE[type] || null;
  const recoilTimeOf = (d) => (d.recoilTime == null ? 1e10 : d.recoilTime);

  // player.damage armor step. Vest is skipped on headshots; the helmet counts fully on
  // headshots and at 30% otherwise. Reductions multiply, they don't add.
  SV.applyArmor = (amount, head, chestLvl, helmetLvl) => {
    let d = amount;
    if (chestLvl && !head) d -= d * C.armor.chest[chestLvl];
    if (helmetLvl) d -= d * C.armor.helmet[helmetLvl] * (head ? 1 : 0.3);
    return d;
  };

  SV.SLOT = { PRIMARY: 0, SECONDARY: 1, MELEE: 2 };

  // Adrenaline tiers (player.ts boostHeals): breakpoints 1:1:1.5:0.5 of 100 = 25 / 50 / 87.5 / 100.
  const boostHeals = [];
  {
    const bp = C.player.boostBreakpoints, max = bp.reduce((a, b) => a + b, 0);
    let top = 0;
    bp.forEach((b, i) => { top += (b / max) * 100; boostHeals.push({ maxBoost: top, heal: C.player.boostHealAmounts[i] }); });
  }
  // Heal per second at a boost level. Like the server's findLast, an exact breakpoint uses the higher tier.
  SV.boostHeal = (boost) => {
    if (boost <= 0) return 0;
    let heal = 0;
    boostHeals.forEach((b, i) => {
      const prev = i ? boostHeals[i - 1].maxBoost : 0;
      if (boost >= prev && boost <= b.maxBoost) heal = b.heal;
    });
    return heal;
  };
  SV.BOOST_SPEED_AT = 50;              // player.recalculateSpeed: boost >= 50 adds boostMoveSpeed

  class Player {
    constructor(world, x, y, opts = {}) {
      this.world = world;
      this.id = opts.id || 'p';
      this.pos = { x, y };
      this.posOld = { x, y };
      this.dir = { x: 1, y: 0 };
      this.rad = C.player.radius;
      this.health = C.player.health;
      this.dead = false;
      this.helmet = opts.helmet || 0;
      this.chest = opts.chest || 0;
      this.slots = [0, 1, 2].map((i) => ({ type: i === 2 ? 'fists' : '', ammo: 0, cooldown: 0, recoilTime: Infinity }));
      this.cur = 2;
      this.lastGun = 0;
      this.freeSwitchTimer = 0;
      this.shotSlowdownTimer = 0;
      this.recoilTicker = 0;
      this.bursts = [];
      this.offHand = false;
      this.meleeAttacks = [];
      this.meleeAnim = 0;           // remaining time of the melee animation (playAnim(Melee, cooldownTime))
      this.bufferInput = false;
      this.scheduledReload = false;
      this.action = null;           // { type: 'reload'|'alt', time, duration }
      this.reloadAgain = false;
      this.input = { up: false, down: false, left: false, right: false, shootHold: false, shootStart: false };
      this.speed = C.player.moveSpeed;
      this.moving = false;
      this.recoilVis = 0;           // visual only
      this.visAnim = null;          // visual only: { name, mirror, t, cache } melee attack / deploy animation
      this.boost = opts.boost || 0; // adrenaline, 0-100
      this.boostDrain = opts.boostDrain !== false;
      this.events = opts.events || {};
    }

    get active() { return this.slots[this.cur].type; }
    get activeDef() { return SV.defOf(this.active); }

    // The pan is "worn" on the back whenever it's the melee weapon and another slot is held (weaponManager.ts).
    get wearingPan() { return this.slots[2].type === 'pan' && this.active !== 'pan'; }
    // player.ts hasActivePan: it blocks on your back, or in your hand except during a swing.
    hasActivePan() { return this.wearingPan || (this.active === 'pan' && this.meleeAnim <= 0); }
    // player.ts getPanSegment + math.transformSegment. survev's y is up, so local y flips here.
    panSegmentAt(pos, dir) {
      const s = SV.MELEE.pan.reflectSurface[this.wearingPan ? 'unequipped' : 'equipped'];
      const at = (q) => ({ x: pos.x + dir.x * q.x + dir.y * q.y, y: pos.y + dir.y * q.x - dir.x * q.y });
      return { p0: at(s.p0), p1: at(s.p1) };
    }

    // weaponManager.setWeapon
    setWeapon(idx, type) {
      const d = SV.defOf(type);
      const s = this.slots[idx];
      s.type = type || (idx === 2 ? 'fists' : '');
      s.cooldown = 0;
      s.ammo = d && d.kind === 'gun' ? d.maxClip : 0;
      if (d && d.kind === 'gun') s.recoilTime = recoilTimeOf(d);
      if (d) s.cooldown = d.switchDelay;
      if (idx === this.cur) this.bursts.length = 0;
    }

    // Training convenience: equip a loadout, hold the first gun, all weapons ready.
    setLoadout(primary, secondary, melee) {
      this.setWeapon(0, primary);
      this.setWeapon(1, secondary);
      this.setWeapon(2, melee || 'fists');
      this.cur = this.slots[0].type ? 0 : this.slots[1].type ? 1 : 2;
      this.lastGun = this.slots[0].type ? 0 : 1;
      this.slots.forEach((s) => (s.cooldown = 0));
      this.freeSwitchTimer = 0;
    }

    // weaponManager.setCurWeapIndex
    switchTo(idx, forceSwitch = false) {
      if (!this.slots[idx].type) return false;
      if (idx === this.cur) return false;
      const curDef = this.activeDef;
      if (curDef.kind === 'gun' && curDef.fireMode === 'burst' && this.bursts.length && !forceSwitch) return false;

      this.meleeAnim = 0;                     // player.cancelAnim()
      this.shotSlowdownTimer = 0;             // <- quickswitch: removes the post-shot slowdown
      this.bursts.length = 0;
      this.meleeAttacks.length = 0;
      this.scheduledReload = false;
      this.recoilTicker = 0;

      const curW = this.slots[this.cur], nextW = this.slots[idx];
      const nd = SV.defOf(nextW.type);
      let eff = 0, free = false;
      if (curW.type && nextW.type) {
        const toGun = nd.kind === 'gun';
        eff = toGun ? nd.switchDelay : 0;
        if (this.freeSwitchTimer < 0) {
          eff = C.player.baseSwitchDelay;
          this.freeSwitchTimer = C.player.freeSwitchCooldown;
          free = true;
        }
        if (toGun && nd.deployGroup != null && curDef.deployGroup != null
            && nd.deployGroup === curDef.deployGroup && curW.cooldown > 0) {
          eff = nd.switchDelay;
          free = false;
        } else if (nd.kind === 'melee') {
          eff = Math.max(nextW.cooldown, nd.switchDelay);
        }
        nextW.cooldown = eff;
      }
      const from = this.cur;
      if (from === 0 || from === 1) this.lastGun = from;
      this.cur = idx;
      this.cancelAction();
      if (nd.kind === 'gun' && nextW.ammo <= 0) this.scheduledReload = true;
      this.visAnim = null;
      if (nd.kind === 'melee' && nd.anim.deployAnims.length) {
        this.playVis(nd.anim.deployAnims[Math.floor(Math.random() * nd.anim.deployAnims.length)], false);
      }
      if (this.events.switch) this.events.switch(this, { from, to: idx, delay: eff, free });
      return true;
    }

    // Space bind, per the user's rules.
    swapKey() {
      const hasP = !!this.slots[0].type, hasS = !!this.slots[1].type;
      if (hasP && hasS) {
        if (this.cur === 0) return this.switchTo(1);
        if (this.cur === 1) return this.switchTo(0);
        return this.switchTo(this.lastGun);
      }
      if (hasP || hasS) {
        const g = hasP ? 0 : 1;
        return this.switchTo(this.cur === 2 ? g : 2);
      }
      return false;
    }

    cancelAction() { this.action = null; }

    playVis(name, mirror) { this.visAnim = SV.ANIM.anims[name] ? { name, mirror, t: 0, cache: {} } : null; }

    // weaponManager.tryReload (reserve ammo treated as infinite)
    tryReload() {
      if (this.action) return;
      if (this.cur === 2) return;
      const s = this.slots[this.cur], d = SV.defOf(s.type);
      if (!d || d.kind !== 'gun') return;
      if (s.ammo >= d.maxClip) return;
      let duration = d.reloadTime, type = 'reload';
      if (d.reloadTimeAlt && s.ammo === 0 /* && invAmmo(inf) > maxReload */) {
        duration = d.reloadTimeAlt; type = 'alt';
      }
      this.action = { type, time: 0, duration };
    }

    // weaponManager.reload
    reload(type) {
      const s = this.slots[this.cur], d = SV.defOf(s.type);
      if (!d || d.kind !== 'gun') return;
      const maxReload = type === 'alt' && d.maxReloadAlt ? d.maxReloadAlt : d.maxReload;
      const space = d.maxClip - s.ammo;
      if (space <= 0) return;
      s.ammo += Math.min(maxReload, space);
      if (s.ammo < d.maxClip) this.reloadAgain = true;
      this.bursts.length = 0;
    }

    // player.recalculateSpeed (no perks / water / adrenaline)
    calcSpeed() {
      let s = C.player.moveSpeed;
      const d = this.activeDef;
      if (this.meleeAttacks.length === 0) s += d.speed.equip;
      if (this.shotSlowdownTimer > 0 && d.speed.attack !== undefined) s += d.speed.attack;
      if (this.boost >= SV.BOOST_SPEED_AT) s += C.player.boostMoveSpeed;
      if (this.shotSlowdownTimer > 0) s *= 0.5;
      return clamp(s, 1, 10000);
    }

    damage(amount, srcDef) {
      if (this.dead) return null;
      let dmg = amount, head = false;
      if (srcDef && srcDef.kind === 'gun' && srcDef.headshotMult != null) {
        head = Math.random() < C.player.headshotChance;
        if (head) dmg *= srcDef.headshotMult;
      }
      dmg = SV.applyArmor(dmg, head, this.chest, this.helmet);
      // dmg = strength of the hit; dealt = what health actually lost (server caps overkill)
      const dealt = Math.min(dmg, this.health);
      this.health -= dealt;
      if (this.health <= 0) { this.health = 0; this.dead = true; }
      return { dmg, dealt, head, killed: this.dead };
    }

    update(dt) {
      if (this.dead) return;
      this.dirOld = this.dirNow || this.dir;   // the pan tests both where it was and where it is
      this.dirNow = this.dir;
      // player.update boost logic: heal by tier, then decay
      if (this.boost > 0) {
        this.health = Math.min(C.player.health, this.health + SV.boostHeal(this.boost) * dt);
        if (this.boostDrain) this.boost = Math.max(0, this.boost - C.player.boostDecay * dt);
      }
      if (this.visAnim) {
        this.visAnim.t += dt;
        const fr = SV.ANIM.anims[this.visAnim.name].frames;
        if (this.visAnim.t >= fr[fr.length - 1].time) this.visAnim = null;
      }
      // player.update: reloadAgain (shell-by-shell) schedules the next reload one tick later
      if (this.reloadAgain) { this.reloadAgain = false; this.scheduledReload = true; }
      // Actions (reload) complete
      if (this.action) {
        this.action.time += dt;
        if (this.action.time >= this.action.duration) {
          const t = this.action.type;
          this.action = null;
          this.reload(t);
        }
      }

      // Movement (player.update): 8-way keys, diagonal normalized, instant velocity
      let mx = 0, my = 0;
      const i = this.input;
      if (i.up) my--;
      if (i.down) my++;
      if (i.left) mx--;
      if (i.right) mx++;
      if (mx && my) { mx *= Math.SQRT1_2; my *= Math.SQRT1_2; }
      if (i.moveDir) { mx = i.moveDir.x; my = i.moveDir.y; }   // touch stick: any angle (player.ts touchMoveDir)
      this.posOld.x = this.pos.x; this.posOld.y = this.pos.y;
      this.moving = !!(mx || my);
      if (this.moving) {
        this.speed = this.calcSpeed();
        this.pos.x += mx * this.speed * dt;
        this.pos.y += my * this.speed * dt;
      }
      // player.update: pushed out of anything it walked into. The game takes 5 small steps per server
      // tick; a single 120Hz step moves about the same distance as one of those.
      if (this.world.field) {
        for (const o of this.world.field.near(this.pos.x, this.pos.y, this.rad + 3)) {
          if (o.dead) continue;
          const dx = this.pos.x - o.x, dy = this.pos.y - o.y, d = Math.hypot(dx, dy), pen = o.r + this.rad - d;
          if (pen <= 0) continue;
          const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
          this.pos.x += nx * (pen + 0.001); this.pos.y += ny * (pen + 0.001);
        }
      }

      this.weaponUpdate(dt);

      this.shotSlowdownTimer -= dt;
      if (this.shotSlowdownTimer <= 0) this.shotSlowdownTimer = 0;
      this.recoilVis = Math.max(0, this.recoilVis - dt * 8);
    }

    // weaponManager.update
    weaponUpdate(dt) {
      this.bufferInput = false;
      this.freeSwitchTimer -= dt;
      this.recoilTicker += dt;
      this.meleeAnim -= dt;
      for (const s of this.slots) { s.cooldown -= dt; s.recoilTime -= dt; }
      const d = this.activeDef;
      if (d.kind === 'gun') this.gunUpdate(dt, d);
      else this.meleeUpdate(dt, d);
      if (!this.bufferInput) this.input.shootStart = false;
    }

    gunUpdate(dt, d) {
      const w = this.slots[this.cur];
      if (w.cooldown <= 0 && this.scheduledReload) { this.scheduledReload = false; this.tryReload(); }
      const i = this.input;
      switch (d.fireMode) {
        case 'auto':
          if (i.shootHold && w.cooldown <= 0) { this.fireWeapon(this.offHand, d); this.offHand = !this.offHand; }
          break;
        case 'single':
          if (i.shootStart) {
            if (w.cooldown < 0) { this.fireWeapon(this.offHand, d); this.offHand = !this.offHand; }
            else if (w.cooldown < 0.1) this.bufferInput = true;
          }
          break;
        case 'burst':
          if (i.shootHold && w.cooldown < 0) {
            w.cooldown = 0;
            for (let k = 0; k < d.burstCount; k++) { this.bursts.push(w.cooldown); w.cooldown += d.burstDelay; }
            this.offHand = !this.offHand;
            w.cooldown += d.fireDelay;
          }
          for (let k = 0; k < this.bursts.length; k++) {
            this.bursts[k] -= dt;
            if (this.bursts[k] <= 0) { this.fireWeapon(this.offHand, d); this.bursts.splice(k, 1); k--; }
          }
          break;
      }
    }

    // weaponManager.fireWeapon
    fireWeapon(offHand, d) {
      const w = this.slots[this.cur];
      this.scheduledReload = w.ammo <= 1;
      if (w.ammo <= 0) return;
      const firstShotAccuracy = w.recoilTime <= 0;
      w.cooldown = d.fireDelay;
      w.recoilTime = recoilTimeOf(d);
      this.shotSlowdownTimer = d.fireDelay;
      this.cancelAction();
      w.ammo--;

      const dir = this.dir;
      const perp = { x: -dir.y, y: dir.x };
      const gunOff = d.isDual ? d.dualOffset * (offHand ? 1 : -1) : d.barrelOffset;
      const gunPos = { x: this.pos.x + perp.x * gunOff, y: this.pos.y + perp.y * gunOff };

      let spread = d.shotSpread || 0;
      if (Math.hypot(this.pos.x - this.posOld.x, this.pos.y - this.posOld.y) > 0.01) spread += d.moveSpread || 0;
      if (this.recoilTicker >= recoilTimeOf(d)) spread = 0;
      this.recoilTicker = 0;

      const shotId = (this.world.shotSeq = (this.world.shotSeq || 0) + 1);
      // weaponManager.fireWeapon: a barrel poking into an obstacle fires from its near side
      let clip = null;
      if (this.world.field) {
        let clipLen = d.barrelLength + 1.5;
        for (const o of this.world.field.near(gunPos.x, gunPos.y, clipLen + 3)) {
          if (o.dead || o.height < C.bulletHeight) continue;
          const t = segCircle(gunPos.x, gunPos.y, gunPos.x + dir.x * clipLen, gunPos.y + dir.y * clipLen, o.x, o.y, o.r);
          if (t == null) continue;
          const hx = gunPos.x + dir.x * clipLen * t, hy = gunPos.y + dir.y * clipLen * t, hd = Math.hypot(hx - o.x, hy - o.y) || 1;
          const nx = (hx - o.x) / hd, ny = (hy - o.y) / hd, px = hx + nx * 0.01, py = hy + ny * 0.01;
          const len = Math.hypot(px - gunPos.x, py - gunPos.y);
          if (len < clipLen) { clipLen = len; clip = { x: px, y: py, nx, ny }; }
        }
      }
      for (let k = 0; k < d.bulletCount; k++) {
        const deviation = firstShotAccuracy ? 0 : rand(-0.5, 0.5) * spread;
        const shotDir = rotate(dir, deviation * DEG);
        let start = { x: gunPos.x + dir.x * d.barrelLength, y: gunPos.y + dir.y * d.barrelLength };
        if (k > 0) {
          start.x += rand(-d.jitter, d.jitter) * 1.11;
          start.y += rand(-d.jitter, d.jitter) * 1.11;
        }
        if (clip) {
          const tx = start.x - gunPos.x, ty = start.y - gunPos.y, tl = Math.hypot(tx, ty) || 1e-5, ux = tx / tl, uy = ty / tl;
          const dn = ux * clip.nx + uy * clip.ny;
          if (dn < -0.00001) {
            const t = ((clip.x - gunPos.x) * clip.nx + (clip.y - gunPos.y) * clip.ny) / dn;
            if (t < tl) { const keep = t - 0.1; start = { x: gunPos.x + ux * keep, y: gunPos.y + uy * keep }; }
          }
        }
        this.world.fireBullet(this, d, start, shotDir, k === 0, shotId);
      }
      this.recoilVis = 1;
      if (this.events.shot) this.events.shot(this, d);
    }

    // weaponManager.meleeUpdate
    meleeUpdate(dt, d) {
      const w = this.slots[this.cur], i = this.input;
      if (this.meleeAnim <= 0 && (i.shootStart || (i.shootHold && d.autoAttack)) && w.cooldown < 0) {
        this.cancelAction();
        this.meleeAnim = d.attack.cooldownTime;
        w.cooldown = d.attack.cooldownTime;
        this.meleeAttacks = [...d.attack.damageTimes];
        // client player.selectAnim: random attack anim; plain fists punch with either hand
        const anims = d.anim.attackAnims;
        const sel = anims[Math.floor(Math.random() * anims.length)];
        this.playVis(sel, sel === 'fists' && anims.length === 1 && Math.random() < 0.5);
        if (this.events.melee) this.events.melee(this, d);
      }
      for (let k = 0; k < this.meleeAttacks.length; k++) {
        this.meleeAttacks[k] -= dt;
        if (this.meleeAttacks[k] <= 0) { this.meleeDamage(d); this.meleeAttacks.splice(k, 1); k--; }
      }
    }

    // weaponManager.getMeleeCollider / meleeDamage. Players come before obstacles, the deepest overlap comes
    // first, and only cleaving weapons hit more than one thing. An obstacle in the way protects a player.
    meleeCollider(d) {
      const ang = Math.atan2(this.dir.y, this.dir.x);
      const off = rotate(d.attack.offset, ang);
      return { x: this.pos.x + off.x, y: this.pos.y + off.y, rad: d.attack.rad };
    }
    meleeDamage(d) {
      const col = this.meleeCollider(d);
      const nearby = this.world.field ? this.world.field.near(col.x, col.y, col.rad + 3).filter((o) => !o.dead && o.height >= C.meleeHeight) : [];
      const hits = [];
      for (const o of nearby) {
        const pen = col.rad + o.r - Math.hypot(o.x - col.x, o.y - col.y);
        if (pen > 0) hits.push({ o, pen, prio: 1 });
      }
      for (const p of this.world.players) {
        if (p === this || p.dead) continue;
        const pen = col.rad + p.rad - Math.hypot(p.pos.x - col.x, p.pos.y - col.y);
        if (pen <= 0) continue;
        if (nearby.some((o) => segCircle(this.pos.x, this.pos.y, p.pos.x, p.pos.y, o.x, o.y, o.r) != null)) continue;
        hits.push({ p, pen, prio: 0 });
      }
      hits.sort((a, b) => (a.prio === b.prio ? b.pen - a.pen : a.prio - b.prio));
      for (const h of d.cleave ? hits : hits.slice(0, 1)) {
        if (h.o) { h.o.damage(d.damage * d.obstacleDamage); continue; }
        const p = h.p;
        {
          const res = p.damage(d.damage, d);
          if (res && this.events.hit) this.events.hit(this, p, res, d);
          // player.ts: melee blood stays at the target's position and drifts along the swing
          const dd = Math.hypot(p.pos.x - this.pos.x, p.pos.y - this.pos.y) || 1;
          this.world.blood.push({ x: p.pos.x, y: p.pos.y, dir: { x: (p.pos.x - this.pos.x) / dd, y: (p.pos.y - this.pos.y) / dd }, born: this.world.time });
        }
      }
    }
  }

  class World {
    constructor() {
      this.players = [];
      this.bullets = [];
      this.blood = [];
      this.field = null;     // obstacles, when the mode has them
      this.time = 0;
    }
    addPlayer(x, y, opts) { const p = new Player(this, x, y, opts); this.players.push(p); return p; }

    // bulletBarn.fireBullet + Bullet constructor (no perks, no variance on gun bullets)
    fireBullet(owner, gunDef, pos, dir, shotFx, shotId, reflectCount = 0) {
      const b = gunDef.bullet;
      const variance = 1 + b.variance;     // varianceT defaults to 1; gun bullets have variance 0
      const distAdjIdx = b.noDistAdj ? 8 : randInt(0, 16);
      const distAdj = remap(distAdjIdx, 0, 16, -1, 1);
      const base = b.distance / Math.pow(C.bulletReflectDistDecay, reflectCount);
      const distance = clamp(base * variance + distAdj, 0, 1e6);
      this.bullets.push({
        owner, gunDef, pos: { ...pos }, start: { ...pos }, dir: { ...dir },
        speed: b.speed * variance, distance, traveled: 0, damage: b.damage, falloff: b.falloff, alive: true, shotFx,
        collided: false, scale: 1, shotId, born: this.time, reflectCount,
      });
    }

    // bullet.ts checkForCollisions, pan part: distance along this move to the pan, and the surface's normal.
    panHit(b, nx, ny, step, p) {
      const oldSeg = p.panSegmentAt(p.posOld, p.dirOld || p.dir), newSeg = p.panSegmentAt(p.pos, p.dir);
      const onOld = segSeg(b.pos.x, b.pos.y, nx, ny, oldSeg.p0, oldSeg.p1);
      const onNew = segSeg(b.pos.x, b.pos.y, nx, ny, newSeg.p0, newSeg.p1);
      const t = onNew != null ? onNew : onOld;
      if (t == null) return null;
      const seg = onOld != null ? newSeg : oldSeg;     // the server's pairing, kept as it is there
      const ex = seg.p1.x - seg.p0.x, ey = seg.p1.y - seg.p0.y, l = Math.hypot(ex, ey) || 1;
      return { dist: t * step - 0.2, normal: { x: -ey / l, y: ex / l } };   // stops 0.2 units short of the surface
    }

    update(dt) {
      this.time += dt;
      for (const p of this.players) p.update(dt);
      while (this.blood.length && this.time - this.blood[0].born > SV.BLOOD.life) this.blood.shift();
      const bounced = [];
      for (const b of this.bullets) {
        if (!b.alive) { if (b.collided) b.scale = Math.max(b.scale - dt * 6, 0); continue; }
        const step = Math.min(b.distance - b.traveled, b.speed * dt);
        const nx = b.pos.x + b.dir.x * step, ny = b.pos.y + b.dir.y * step;
        // segment vs circle and pan, nearest hit. A reflected bullet can hit whoever fired it (damageSelf).
        let hit = null, hitT = Infinity, pan = null, panD = Infinity, panBy = null;
        for (const p of this.players) {
          if ((p === b.owner && !b.reflectCount) || p.dead) continue;
          const t = segCircle(b.pos.x, b.pos.y, nx, ny, p.pos.x, p.pos.y, p.rad);
          const ph = p.hasActivePan() ? this.panHit(b, nx, ny, step, p) : null;
          if (t != null && (!ph || t * step < ph.dist)) { if (t < hitT) { hitT = t; hit = p; } }
          else if (ph && ph.dist < panD) { panD = ph.dist; pan = ph; panBy = p; }
        }
        // bullet.ts: obstacles tall enough stop the bullet and take its damage times the bullet's obstacle multiplier
        if (this.field) {
          let ob = null, obD = Infinity;
          for (const o of this.field.near((b.pos.x + nx) / 2, (b.pos.y + ny) / 2, step + 3)) {
            if (o.dead || o.height < C.bulletHeight) continue;
            const t = segCircle(b.pos.x, b.pos.y, nx, ny, o.x, o.y, o.r);
            if (t != null && t * step < obD) { obD = t * step; ob = o; }
          }
          if (ob && obD < (hit ? hitT * step : Infinity) && obD < (pan ? panD : Infinity)) {
            b.traveled += step;
            b.pos.x += b.dir.x * obD; b.pos.y += b.dir.y * obD;
            let dmg = b.damage / (b.reflectCount + 1);
            if (C.bulletFalloff) dmg *= remap(clamp(b.traveled / b.distance, 0, 1), 0, 1, 1, b.falloff);
            ob.damage(dmg * b.gunDef.bullet.obstacleDamage);
            b.alive = false;
            b.collided = true;
            continue;
          }
        }
        if (pan && (!hit || panD < hitT * step)) {
          b.traveled += step;
          b.pos.x += b.dir.x * panD; b.pos.y += b.dir.y * panD;
          b.alive = false;
          b.collided = true;
          if (b.reflectCount < C.bulletMaxReflect) {   // bullet.reflect
            const dot = b.dir.x * pan.normal.x + b.dir.y * pan.normal.y;
            bounced.push({ b, pos: { ...b.pos }, dir: { x: b.dir.x - 2 * dot * pan.normal.x, y: b.dir.y - 2 * dot * pan.normal.y } });
          }
          if (panBy.events.reflect) panBy.events.reflect(panBy, b);
          continue;
        }
        if (hit) {
          b.traveled += step;          // bullet.update adds the whole move before checking collisions
          b.pos.x += b.dir.x * step * hitT; b.pos.y += b.dir.y * step * hitT;
          let dmg = b.damage / (b.reflectCount + 1);   // bullet.ts: each bounce divides the damage
          if (C.bulletFalloff) dmg *= remap(clamp(b.traveled / b.distance, 0, 1), 0, 1, 1, b.falloff);
          // bullet.ts: bullet blood is attached to the player who was hit, at the point of impact
          this.blood.push({ on: hit, x: b.pos.x - hit.pos.x, y: b.pos.y - hit.pos.y, born: this.time });
          const res = hit.damage(dmg, b.gunDef);
          if (res && b.owner.events.hit) b.owner.events.hit(b.owner, hit, res, b.gunDef, b.shotId);
          b.alive = false;
          b.collided = true;           // client: tracer shrinks out after a hit
          continue;
        }
        b.pos.x = nx; b.pos.y = ny;
        b.traveled += step;
        if (b.traveled >= b.distance - 1e-6) b.alive = false;   // client: hidden at max range
      }
      this.bullets = this.bullets.filter((b) => b.alive || (b.collided && b.scale > 0));
      for (const r of bounced) this.fireBullet(r.b.owner, r.b.gunDef, r.pos, r.dir, false, r.b.shotId, r.b.reflectCount + 1);
    }
  }

  // Returns t in [0,1] along segment AB where it crosses segment p0-p1, or null (coldet.intersectSegmentSegment).
  function segSeg(ax, ay, bx, by, p0, p1) {
    const rx = bx - ax, ry = by - ay, sx = p1.x - p0.x, sy = p1.y - p0.y;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) return null;
    const qx = p0.x - ax, qy = p0.y - ay;
    const t = (qx * sy - qy * sx) / denom, u = (qx * ry - qy * rx) / denom;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  }

  // Returns t in [0,1] of first intersection of segment AB with circle (C, r), or null.
  function segCircle(ax, ay, bx, by, cx, cy, r) {
    const dx = bx - ax, dy = by - ay;
    const fx = ax - cx, fy = ay - cy;
    const a = dx * dx + dy * dy;
    const c = fx * fx + fy * fy - r * r;
    if (c <= 0) return 0;
    if (a < 1e-12) return null;
    const bq = 2 * (fx * dx + fy * dy);
    const disc = bq * bq - 4 * a * c;
    if (disc < 0) return null;
    const t = (-bq - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : null;
  }

  SV.Player = Player;
  SV.World = World;
  SV.segCircle = segCircle;
})();
