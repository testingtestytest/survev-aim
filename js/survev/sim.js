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
      this.posOld.x = this.pos.x; this.posOld.y = this.pos.y;
      this.moving = !!(mx || my);
      if (this.moving) {
        this.speed = this.calcSpeed();
        this.pos.x += mx * this.speed * dt;
        this.pos.y += my * this.speed * dt;
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
      for (let k = 0; k < d.bulletCount; k++) {
        const deviation = firstShotAccuracy ? 0 : rand(-0.5, 0.5) * spread;
        const shotDir = rotate(dir, deviation * DEG);
        let start = { x: gunPos.x + dir.x * d.barrelLength, y: gunPos.y + dir.y * d.barrelLength };
        if (k > 0) {
          start.x += rand(-d.jitter, d.jitter) * 1.11;
          start.y += rand(-d.jitter, d.jitter) * 1.11;
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

    // weaponManager.getMeleeCollider / meleeDamage (players only, no obstacles)
    meleeCollider(d) {
      const ang = Math.atan2(this.dir.y, this.dir.x);
      const off = rotate(d.attack.offset, ang);
      return { x: this.pos.x + off.x, y: this.pos.y + off.y, rad: d.attack.rad };
    }
    meleeDamage(d) {
      const col = this.meleeCollider(d);
      for (const p of this.world.players) {
        if (p === this || p.dead) continue;
        if (Math.hypot(p.pos.x - col.x, p.pos.y - col.y) < col.rad + p.rad) {
          const res = p.damage(d.damage, d);
          if (res && this.events.hit) this.events.hit(this, p, res, d);
        }
      }
    }
  }

  class World {
    constructor() {
      this.players = [];
      this.bullets = [];
      this.time = 0;
    }
    addPlayer(x, y, opts) { const p = new Player(this, x, y, opts); this.players.push(p); return p; }

    // bulletBarn.fireBullet + Bullet constructor (no perks, no variance on gun bullets)
    fireBullet(owner, gunDef, pos, dir, shotFx, shotId) {
      const b = gunDef.bullet;
      const variance = 1 + b.variance;     // varianceT defaults to 1; gun bullets have variance 0
      const distAdjIdx = b.noDistAdj ? 8 : randInt(0, 16);
      const distAdj = remap(distAdjIdx, 0, 16, -1, 1);
      const distance = clamp(b.distance * variance + distAdj, 0, 1e6);
      this.bullets.push({
        owner, gunDef, pos: { ...pos }, start: { ...pos }, dir: { ...dir },
        speed: b.speed * variance, distance, traveled: 0, damage: b.damage, falloff: b.falloff, alive: true, shotFx,
        collided: false, scale: 1, shotId, born: this.time,
      });
    }

    update(dt) {
      this.time += dt;
      for (const p of this.players) p.update(dt);
      for (const b of this.bullets) {
        if (!b.alive) { if (b.collided) b.scale = Math.max(b.scale - dt * 6, 0); continue; }
        const step = Math.min(b.distance - b.traveled, b.speed * dt);
        const nx = b.pos.x + b.dir.x * step, ny = b.pos.y + b.dir.y * step;
        // segment vs circle, nearest hit
        let hit = null, hitT = Infinity;
        for (const p of this.players) {
          if (p === b.owner || p.dead) continue;
          const t = segCircle(b.pos.x, b.pos.y, nx, ny, p.pos.x, p.pos.y, p.rad);
          if (t != null && t < hitT) { hitT = t; hit = p; }
        }
        if (hit) {
          b.traveled += step;          // bullet.update adds the whole move before checking collisions
          b.pos.x += b.dir.x * step * hitT; b.pos.y += b.dir.y * step * hitT;
          let dmg = b.damage;
          if (C.bulletFalloff) dmg *= remap(clamp(b.traveled / b.distance, 0, 1), 0, 1, 1, b.falloff);
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
    }
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
