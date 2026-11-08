// Bot "player": drives an SV.Player with keyboard-style 8-way input like a real survev player.
// It strafes around a preferred distance, sometimes rushes into melee range, can fire back,
// and can dodge bullets it has had time to react to. How well it does all this is its skill.
(function () {
  const { rand } = SV.util;
  const C = SV.CONFIG;
  const DIRS = [...Array(8)].map((_, k) => ({ x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) }));
  const RUSH_GAP = { never: null, sometimes: [8, 14], often: [4, 7] };

  // Per skill level:
  //  Strafing   run: seconds before changing direction, stop: chance of standing still (an easy target),
  //             tol: how closely it sticks to moving across your line of fire (lower = stricter)
  //  Aim        shotErr: per-shot spread in degrees (std dev), react: s to adapt to your direction changes,
  //             leadErr: how far its lead wanders from perfect, track: crosshair follow rate
  //  Dodging    dodge: chance it tries to dodge a shot it has seen
  //  Switching  qs: chance it quickswitches after a single shot, qsDelay: seconds before it does (also how
  //             fast it changes guns on an empty mag), qsCare: only switches when that's faster than waiting,
  //             reloadBoth: reloads both guns before fighting again
  //  Close up   closeMelee: chance it goes to melee when you're super close, charge: chances per second
  //             it charges you with melee when you're close, gunSense: chance it acts on the right gun for
  //             the range (shotgun close, the other gun far)
  //  Reloading  reloadTo: share of a shell-by-shell gun's mag it loads before firing again
  //  Obstacles  replan: seconds between path updates, seekAfter: seconds without seeing you before it goes
  //             looking, losCare: chance it holds fire instead of shooting an obstacle in the way
  SV.BOT_SKILL = {
    low:    { run: [0.5, 1.2],  stop: 0.25, tol: 0.95, shotErr: 3.2, react: 0.32, leadErr: 0.55, track: 6,  dodge: 0.15, qs: 0.2,  qsDelay: [0.3, 0.6],   qsCare: false, reloadBoth: false, closeMelee: 0.3,  charge: 0.02, gunSense: 0.25, reloadTo: 0.34, replan: 0.5,  seekAfter: 1.6, losCare: 0.4 },
    medium: { run: [0.3, 0.8],  stop: 0.12, tol: 0.75, shotErr: 1.8, react: 0.22, leadErr: 0.3,  track: 9,  dodge: 0.4,  qs: 0.5,  qsDelay: [0.15, 0.35], qsCare: false, reloadBoth: true,  closeMelee: 0.6,  charge: 0.05, gunSense: 0.55, reloadTo: 0.45, replan: 0.3,  seekAfter: 1,   losCare: 0.7 },
    high:   { run: [0.2, 0.55], stop: 0.05, tol: 0.5,  shotErr: 0.9, react: 0.14, leadErr: 0.15, track: 14, dodge: 0.7,  qs: 0.85, qsDelay: [0.08, 0.18], qsCare: true,  reloadBoth: true,  closeMelee: 0.85, charge: 0.08, gunSense: 0.85, reloadTo: 0.55, replan: 0.2,  seekAfter: 0.6, losCare: 0.95 },
    pro:    { run: [0.12, 0.4], stop: 0.02, tol: 0.4,  shotErr: 0.5, react: 0.1,  leadErr: 0.08, track: 18, dodge: 0.95, qs: 1,    qsDelay: [0.03, 0.08], qsCare: true,  reloadBoth: true,  closeMelee: 1,    charge: 0.1,  gunSense: 1,    reloadTo: 0.67, replan: 0.12, seekAfter: 0.3, losCare: 1 },
  };
  const WIDE_MULT = 2.2;              // "wide" movement = longer runs in one direction
  const SPRAY_BREAK = 0.35;           // radians (~20°) off aim before it lets go of the trigger
  const BURST_CHANCE = 0.25;          // chance a trigger pull is a short burst instead of a mag dump
  const BURST_HOLD = [0.25, 0.5];     // how long a short burst holds the trigger
  const BURST_PAUSE = [0.3, 0.7];     // pause after a short burst
  const DODGE_MARGIN = 0.5;           // units of clearance beyond the hitbox that still count as a threat
  const SHAKE_MIN_COOLDOWN = 0.6;     // s left on the gun before pulling out melee to lose the slowdown is worth it
  const CARE_SLACK = 0.2;             // s a careful bot will give up to alternate guns instead of refiring
  const ERR_CHANGE = [0.15, 0.35];    // s between changes of where its hand error is heading
  const ERR_SMOOTH = 10;              // how quickly its aim follows that change, per second
  // Melee, in units from you. Fists reach about 3.25.
  const MELEE_CLOSE = 3.5;            // "super close": it may go to melee
  const MELEE_GIVE_UP = 5.5;          // you got away from a close-up fight
  const MELEE_REROLL = 6;             // beyond this it rolls again as soon as you're super close
  const MELEE_FIGHT = [1.5, 3];       // s a close-up fight lasts
  const MELEE_RETRY = 1.5;            // s before it decides again if you stay super close
  const MELEE_BAND = [1.4, 2.6];      // the distance it keeps while fighting with melee
  const CHARGE_DIST = 10;             // you're close enough to charge
  const CHARGE_TIME = [1.2, 2.2];     // s before it gives up a charge
  const CHARGE_LOW_HP = 4;            // extra charge rate at 0 health, fading to none at full health
  const RELOAD_INTERRUPT = 6;         // closer than this it fires whatever it has loaded, mid-reload or not
  // Finding a way around obstacles.
  const NAV_CLEAR = 0.45;             // units it tries to leave between itself and an obstacle
  const NAV_LOOK = 2.5;               // how far ahead it checks a direction before choosing it
  const NAV_TURN = 1.2;               // how close an obstacle gets before it turns away mid-run
  const WAYPOINT_REACHED = 0.8;
  const STUCK_TIME = 0.35;            // s of barely moving before it tries something else
  const STUCK_SHARE = 0.3;            // "barely moving": less than this share of its speed
  // Which gun suits the range.
  const SHOTGUN_NEAR = 10;            // closer than this it wants the shotgun
  const SHOTGUN_FAR = 14;             // further than this it wants the other gun
  const SENSE_EVERY = [0.3, 0.6];     // s between checks that it's holding the right one
  const SENSE_AFTER_QS = [1.2, 1.6];  // s after a quickswitch before that check, so the shot gets fired
  const PREFER_STAY = 0.85;           // how much less it quickswitches away from the gun that suits the range

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
      this.errNow = 0;                    // where its hand is off by right now, in radians
      this.errGoal = 0;
      this.errT = 0;
      this.closeFightT = 0;               // time left in a close-up melee fight
      this.closeNext = 0;                 // time before it decides about one again
      this.charge = false;                // on a melee charge
      this.meleeIn = 0;                   // reaction time before pulling out melee
      this.heldForFight = false;
      this.senseT = 0;
      this.charges = 0;                   // stats, used by the tests
      this.path = null;                   // waypoints around obstacles
      this.pathI = 0;
      this.planT = 0;
      this.noSightT = 0;                  // how long an obstacle has been between you
      this.sightBlocked = false;
      this.shootBlind = false;
      this.stuckT = 0;
    }

    nextRush() { const g = RUSH_GAP[this.o.rush]; return g ? rand(g[0], g[1]) : Infinity; }

    // The distances it's happy at right now, as [closest, furthest].
    range() {
      if (this.p.cur === 2 && this.fightMelee()) return MELEE_BAND;
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
      this.mode = 'hold'; this.rushIn = this.nextRush(); this.dirT = 0; this.charge = false;
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
      if (this.mode === 'rush' || (this.p.cur === 2 && this.fightMelee() && d > hi)) want = -0.9;
      else if (d > hi) want = -0.7;
      else if (d < lo) want = 0.7;
      else { want = 0; tol = this.S.tol; }   // in range: strafe across the line of fire
      const cands = [];
      DIRS.forEach((v, k) => {
        if (k === this.dirIdx || this.leavesScreen(v) || this.runsIntoObstacle(v)) return;
        const r = v.x * away.x + v.y * away.y;
        if (Math.abs(r - want) < tol) cands.push(k);
      });
      if (cands.length) this.dirIdx = cands[Math.floor(Math.random() * cands.length)];
      else if (this.dynamic && this.mode === 'hold') {
        // boxed in by the screen edge: slide along it, or come back toward you if there's no way along
        const free = DIRS.map((v, k) => k).filter((k) => !this.leavesScreen(DIRS[k]) && !this.runsIntoObstacle(DIRS[k]));
        const score = (k) => -Math.abs(DIRS[k].x * away.x + DIRS[k].y * away.y - want);
        this.dirIdx = free.reduce((a, k) => (a < 0 || score(k) > score(a) ? k : a), -1);
      } else {
        this.dirIdx = Math.floor(Math.random() * 8);
        if (this.runsIntoObstacle(DIRS[this.dirIdx])) {
          const free = DIRS.map((v, k) => k).filter((k) => !this.runsIntoObstacle(DIRS[k]));
          if (free.length) this.dirIdx = free[Math.floor(Math.random() * free.length)];
        }
      }
    }

    fightMelee() { return this.charge || this.closeFightT > 0; }

    // Shots a gun needs before the bot stops reloading it. A shell-by-shell gun would otherwise fire
    // the first shell in, which cancels the reload and leaves it on an almost empty gun.
    enoughAmmo(d) { return d.maxReload >= d.maxClip ? d.maxClip : Math.ceil(d.maxClip * this.S.reloadTo); }

    // Decides on melee: when you're super close, and sometimes a charge when you're close, more
    // often the lower its health. A bot set to never rush doesn't charge.
    meleeThinking(dist, dt) {
      const p = this.p, S = this.S;
      if (!p.slots[2].type) return;
      this.closeFightT -= dt;
      this.closeNext -= dt;
      if (dist > MELEE_GIVE_UP) this.closeFightT = 0;
      if (dist > MELEE_REROLL) this.closeNext = 0;
      if (dist < MELEE_CLOSE && this.closeNext <= 0 && !this.charge) {
        const go = Math.random() < S.closeMelee;
        this.closeFightT = go ? rand(MELEE_FIGHT[0], MELEE_FIGHT[1]) : 0;
        this.closeNext = this.closeFightT + MELEE_RETRY;
        if (go) this.meleeIn = rand(S.qsDelay[0], S.qsDelay[1]);
      }
      if (this.mode === 'hold' && this.o.rush !== 'never' && dist >= MELEE_CLOSE && dist < CHARGE_DIST) {
        const hurt = 1 - Math.max(0, p.health) / C.player.health;
        if (Math.random() < S.charge * (1 + CHARGE_LOW_HP * hurt) * dt) {
          this.charge = true; this.charges++;
          this.mode = 'rush'; this.dirT = 0;
          this.modeT = rand(CHARGE_TIME[0], CHARGE_TIME[1]);
          this.meleeIn = rand(S.qsDelay[0], S.qsDelay[1]);
        }
      }
    }

    // The slot that suits this range, when it has a shotgun and a gun that isn't. Otherwise null.
    preferredSlot(dist) {
      const a = SV.defOf(this.p.slots[0].type), b = SV.defOf(this.p.slots[1].type);
      if (!a || !b || (a.cls === 'SHOTGUN') === (b.cls === 'SHOTGUN')) return null;
      const shotgun = a.cls === 'SHOTGUN' ? 0 : 1;
      return dist < SHOTGUN_NEAR ? shotgun : dist > SHOTGUN_FAR ? 1 - shotgun : null;
    }

    gunAfterMelee(dist) {
      const p = this.p, k = this.preferredSlot(dist);
      return k != null && p.slots[k].ammo > 0 && Math.random() < this.S.gunSense ? k : p.lastGun;
    }

    // Melee, then two guns: change guns on an empty mag instead of reloading, alternate them with
    // quickswitches after single shots, and hold the one that suits the range.
    gunSwitching(dt, dist) {
      const p = this.p, S = this.S, other = p.cur === 0 ? 1 : 0;
      if (p.cur === 2) {
        if (this.fightMelee()) { this.heldForFight = true; return; }
        // After a fight it goes straight back. If it only pulled melee out to run at full speed, it goes
        // back just in time for the gun's next shot, so that doesn't change how often it fires.
        const g = p.slots[p.lastGun];
        if (this.heldForFight) { this.heldForFight = false; p.switchTo(this.gunAfterMelee(dist)); }
        else if (g.type && g.cooldown <= C.player.baseSwitchDelay && p.freeSwitchTimer < 0) p.switchTo(p.lastGun);
        return;
      }
      if (this.fightMelee()) {
        if ((this.meleeIn -= dt) <= 0 && p.switchTo(2)) { this.spraying = false; this.qsT = null; }
        return;
      }
      const w = p.slots[p.cur], o = p.slots[other], d = p.activeDef;
      const fired = this.ammoSlot === p.cur && w.ammo < this.ammoSeen && d.fireMode === 'single';
      this.ammoSlot = p.cur; this.ammoSeen = w.ammo;
      // One gun: any switch clears the post-shot slowdown, so better players pull out melee between shots.
      if (!o.type) {
        if (fired && w.ammo > 0 && Math.random() < S.qs) this.qsT = rand(S.qsDelay[0], S.qsDelay[1]);
        if (this.qsT != null && (this.qsT -= dt) <= 0) {
          this.qsT = null;
          if (w.cooldown > SHAKE_MIN_COOLDOWN && p.slots[2].type) p.switchTo(2);
        }
        return;
      }
      if (fired && o.ammo > 0) {
        const stay = this.preferredSlot(dist) === p.cur ? 1 - S.gunSense * PREFER_STAY : 1;
        if (Math.random() < S.qs * stay) this.qsT = rand(S.qsDelay[0], S.qsDelay[1]);
      }
      if (w.ammo >= this.enoughAmmo(d) && this.reloadSlot === p.cur) { this.reloadSlot = null; this.topUp = true; }
      if (o.ammo > 0) this.topUp = false;
      // Empty: change to the other gun rather than reload this one. If both are empty, change once and
      // reload that one, so the bot keeps using both guns instead of settling on the last one it fired.
      if (w.ammo === 0 && this.reloadSlot !== p.cur && !p.action) {
        // At long range, a bot with sense reloads its long-range gun instead of falling back on the shotgun.
        if (this.swapT == null && d.cls !== 'SHOTGUN' && this.preferredSlot(dist) === p.cur && Math.random() < S.gunSense) {
          this.reloadSlot = p.cur;
          return;
        }
        p.scheduledReload = false;
        if (this.swapT == null) this.swapT = rand(S.qsDelay[0], S.qsDelay[1]);
        if ((this.swapT -= dt) <= 0) {
          if (o.ammo === 0) this.reloadSlot = other;
          this.swapT = this.qsT = null; this.spraying = false;
          p.switchTo(other);
        }
        return;
      }
      this.swapT = null;
      // Better players follow one reload with the other gun's, or they lose the quickswitch.
      if (S.reloadBoth && this.topUp && w.ammo >= this.enoughAmmo(d) && o.ammo === 0) {
        this.topUp = false; this.reloadSlot = other; this.qsT = null; this.spraying = false;
        p.switchTo(other);
        return;
      }
      const cost = p.freeSwitchTimer < 0 ? C.player.baseSwitchDelay : SV.defOf(o.type).switchDelay;
      if (this.qsT != null && (this.qsT -= dt) <= 0) {
        if (o.ammo <= 0 || p.bursts.length) { this.qsT = null; return; }
        // A careful bot waits for the free switch if it isn't worth paying full price yet.
        if (!S.qsCare || cost < w.cooldown + CARE_SLACK) {
          this.qsT = null; this.spraying = false;
          this.senseT = rand(SENSE_AFTER_QS[0], SENSE_AFTER_QS[1]);
          p.switchTo(other);
          return;
        }
        if (w.cooldown <= 0) this.qsT = null;
      }
      if ((this.senseT -= dt) <= 0) {
        this.senseT = rand(SENSE_EVERY[0], SENSE_EVERY[1]);
        if (this.preferredSlot(dist) === other && o.ammo > 0 && !p.action && !p.bursts.length && this.reloadSlot == null
            && (!S.qsCare || cost <= Math.max(w.cooldown, C.player.baseSwitchDelay)) && Math.random() < S.gunSense) {
          this.qsT = null; this.spraying = false;
          p.switchTo(other);
        }
      }
    }

    runsIntoObstacle(v, look = NAV_LOOK) {
      const f = this.p.world && this.p.world.field;
      return !!f && f.ahead(this.p.pos, v, look, this.p.rad);
    }

    // Can it see you past the obstacles? When it loses sight of you, it decides whether to hold fire.
    checkSight(dt) {
      const f = this.p.world && this.p.world.field;
      if (!f) return;
      const blocked = f.blocked(this.p.pos, this.t.pos);
      if (blocked && !this.sightBlocked) this.shootBlind = Math.random() > this.S.losCare;
      this.sightBlocked = blocked;
      this.noSightT = blocked ? this.noSightT + dt : 0;
    }

    // Walks a path around obstacles when one is in the way of getting to you, or when it's lost sight of you
    // for long enough. Otherwise normal movement carries on. True while it's following a path.
    navigate(dist, dt) {
      const p = this.p, t = this.t, f = p.world && p.world.field;
      if (!f || this.o.still) return false;
      const closing = this.mode === 'rush' || dist > this.range()[1];
      const seeking = this.noSightT > this.S.seekAfter;
      if (!(closing || seeking) || !f.blocked(p.pos, t.pos, p.rad + NAV_CLEAR)) { this.path = null; return false; }
      if ((this.planT -= dt) <= 0 || !this.path) {
        this.planT = this.S.replan;
        this.path = f.findPath(p.pos, t.pos, p.rad, NAV_CLEAR);
        this.pathI = 0;
      }
      if (!this.path) return false;
      while (this.pathI < this.path.length && Math.hypot(this.path[this.pathI].x - p.pos.x, this.path[this.pathI].y - p.pos.y) < WAYPOINT_REACHED) this.pathI++;
      if (this.pathI >= this.path.length) { this.path = null; return false; }
      const w = this.path[this.pathI], dx = w.x - p.pos.x, dy = w.y - p.pos.y, d = Math.hypot(dx, dy) || 1;
      let best = 0, bestDot = -2;
      DIRS.forEach((v, k) => { const q = (v.x * dx + v.y * dy) / d; if (q > bestDot) { bestDot = q; best = k; } });
      this.dirIdx = best;
      return true;
    }

    // Long runs can overshoot a narrow band or the screen edge, so a dynamic bot turns early.
    offCourse(dist) {
      // In a melee fight, turn back as soon as it's moving out of reach.
      if (this.p.cur === 2 && this.fightMelee() && this.dirIdx >= 0 && dist > MELEE_BAND[1]) {
        const m = DIRS[this.dirIdx];
        return (m.x * (this.p.pos.x - this.t.pos.x) + m.y * (this.p.pos.y - this.t.pos.y)) / dist > -0.3;
      }
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
      this.checkSight(dt);
      const onPath = this.dodgeT <= 0 && this.navigate(dist, dt);
      if (!onPath && p.world && p.world.field && this.dirIdx >= 0 && this.dodgeT <= 0) {
        // turn before walking into something, and try another way if it's not getting anywhere
        if (this.runsIntoObstacle(DIRS[this.dirIdx], NAV_TURN)) this.dirT = 0;
        const moved = Math.hypot(p.pos.x - p.posOld.x, p.pos.y - p.posOld.y) / dt;
        this.stuckT = moved < p.calcSpeed() * STUCK_SHARE ? this.stuckT + dt : 0;
        if (this.stuckT > STUCK_TIME) { this.stuckT = 0; this.dirT = 0; this.path = null; }
      }
      if (this.o.still) { this.dirIdx = -1; }
      else if (onPath) { /* the path sets its direction */ }
      else if ((this.dirT -= dt) <= 0) {
        if (this.mode !== 'rush' && Math.random() < S.stop) { this.dirIdx = -1; this.dirT = rand(0.15, 0.35); }
        else {
          this.pickDir();
          const m = this.runStyle === 'wide' ? WIDE_MULT : 1;
          this.dirT = this.mode === 'rush' ? rand(0.2, 0.4) : rand(S.run[0] * m, S.run[1] * m);
          // Runs are set by distance: the post-shot slowdown halves speed, so they last longer while it's on.
          this.dirT += Math.min(this.dirT, p.shotSlowdownTimer / 2);
        }
      }
      const v = this.dirIdx >= 0 ? DIRS[this.dirIdx] : { x: 0, y: 0 };
      i.right = v.x > 0.3; i.left = v.x < -0.3; i.down = v.y > 0.3; i.up = v.y < -0.3;

      if (this.o.fire) { this.meleeThinking(dist, dt); this.gunSwitching(dt, dist); }

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
      // Its hand error drifts instead of being picked afresh every shot, so its aim doesn't shake.
      if (this.o.fire) {
        if ((this.errT -= dt) <= 0) { this.errGoal = (gauss() * S.shotErr * Math.PI) / 180; this.errT = rand(ERR_CHANGE[0], ERR_CHANGE[1]); }
        this.errNow += (this.errGoal - this.errNow) * Math.min(1, ERR_SMOOTH * dt);
      }
      p.dir = { x: Math.cos(this.aimAng + this.errNow), y: Math.sin(this.aimAng + this.errNow) };

      // ---- shooting ----
      i.shootHold = false;
      if (this.o.fire && !t.dead) {
        const inRange = d.kind === 'gun' ? dist < d.bullet.distance * 0.9 : dist < 3;
        const onTarget = Math.abs(diff) < Math.max(0.05, Math.atan2(t.rad * 1.5, dist));
        const isAuto = d.kind === 'gun' && (d.fireMode === 'auto' || d.fireMode === 'burst');
        const ammo = p.slots[p.cur].ammo;
        const midReload = d.kind === 'gun' && (p.action || p.reloadAgain || this.reloadSlot === p.cur) && ammo < this.enoughAmmo(d) && dist >= RELOAD_INTERRUPT;
        const holdFire = this.sightBlocked && !this.shootBlind;      // don't waste shots on a tree in the way
        const hasAmmo = d.kind !== 'gun' || (ammo > 0 && !midReload && !holdFire);
        // Automatic guns are mostly mag dumped: once it starts, it keeps the trigger held until the
        // mag is empty, you're out of range or its aim is way off. Sometimes it's just a short burst.
        if (this.spraying) {
          if (!inRange || !hasAmmo || Math.abs(diff) > SPRAY_BREAK) this.spraying = false;
          else if ((this.sprayLeft -= dt) <= 0) { this.spraying = false; this.fireT = rand(BURST_PAUSE[0], BURST_PAUSE[1]); }
        }
        if (this.spraying || (inRange && onTarget && (this.fireT -= dt) <= 0)) {
          if (isAuto) {
            if (!this.spraying && hasAmmo) {
              this.spraying = true;
              this.sprayLeft = Math.random() < BURST_CHANCE ? rand(BURST_HOLD[0], BURST_HOLD[1]) : Infinity;
            }
            if (hasAmmo) i.shootHold = true;
          } else if (hasAmmo && p.slots[p.cur].cooldown < 0) { i.shootStart = true; this.fireT = rand(0.05, 0.25); }
        }
        const twoGuns = p.cur < 2 && p.slots[1 - p.cur].type;
        if (d.kind === 'gun' && ((ammo === 0 && !twoGuns) || (this.reloadSlot === p.cur && ammo < this.enoughAmmo(d)))) p.tryReload();
      }
    }
  }

  SV.Bot = Bot;
})();
