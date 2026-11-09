// Bot "player": drives an SV.Player with keyboard-style 8-way input like a real survev player.
// It strafes around a preferred distance, sometimes rushes into melee range, can fire back,
// and can dodge bullets it has had time to react to. How well it does all this is its skill.
(function () {
  const { rand } = SV.util;
  const C = SV.CONFIG;
  const DIRS = [...Array(8)].map((_, k) => ({ x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) }));
  const RUSH_GAP = { never: null, sometimes: [16, 28], often: [7, 12] };

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
  //             the range (shotgun close, the other gun far), chargeRead: chance it waits for an opening
  //             before charging and calls a charge off if you recover, chargeWeave: chance it weaves on the way in
  //  Backing off  reloadBack: chance it gives ground when it starts a reload, hurtBack: chance it does when hurt
  //  Items      medCare: chance per check it does something about needing an item, medAt: health it heals below,
  //             boostAt: adrenaline it tops up below, medCancel: chance it stops using one when it's in danger
  //  Grenades   nadeCare: chance per check it throws one, nadeHide: seconds you've been out of sight before it thinks
  //             of it, nadeAim: how far off it lands (units, std dev), nadeCook: how much of the fuse it burns off so
  //             there's less time to run, nadeLead: how well it allows for its own movement, nadeFear: chance it
  //             runs from a grenade near it
  //  Reloading  reloadTo: share of a shell-by-shell gun's mag it loads before firing again
  //  Breaking   breakCare: chance it thinks of shooting out the obstacle you're behind, spare: how much of
  //             your health it wants to be able to deal afterward (0 = doesn't count its bullets)
  //  Cover      coverCare: chance it goes behind cover to reload, coverReach: units it'll look for it
  //  Sneaking   sneakCare: chance per check it reloads a part-empty mag when safe, sneakAt: how full a mag
  //             can still be (share of the clip), sneakQuiet: seconds since your last shot that feel safe,
  //             sneakReads: it notices when you're reloading
  //  Peeking    peekCare: chance per check it fights a burst gun from behind cover, peekHide: seconds it stays
  //             hidden between peeks
  //  Shielding  shieldCare: chance it shields with its pan when you spray it, showerShots: shots of yours in
  //             SHOWER_WINDOW that count as being sprayed, shieldHold: seconds it stays shielded between peeks
  //  Your pan   panRespect: chance it holds fire while your pan faces it, waiting for an opening
  //  Pan        panCare: chance it turns the pan toward you in a gap between shots, panErr: how far off it
  //             lands in degrees (std dev)
  //  Obstacles  replan: seconds between path updates, seekAfter: seconds without seeing you before it goes
  //             looking, losCare: chance it holds fire instead of shooting an obstacle in the way
  SV.BOT_SKILL = {
    low:    { run: [0.5, 1.2],  stop: 0.25, tol: 0.95, shotErr: 3.2, react: 0.32, leadErr: 0.55, track: 6,  dodge: 0.15, qs: 0.2,  qsDelay: [0.3, 0.6],   qsCare: false, reloadBoth: false, closeMelee: 0.3,  charge: 0.02, gunSense: 0.25, reloadTo: 0.34, replan: 0.5,  seekAfter: 1.6, losCare: 0.4,  panCare: 0.2,  panErr: 25, breakCare: 0.2,  spare: 0,    coverCare: 0.1, coverReach: 6,  sneakCare: 0.1, sneakAt: 0.25, sneakQuiet: 2.5, sneakReads: false, peekCare: 0.1, peekHide: [1, 2],      panRespect: 0.2,  shieldCare: 0.15, showerShots: 5, shieldHold: [0.5, 1], chargeRead: 0.1,  chargeWeave: 0,   reloadBack: 0.15, hurtBack: 0.2, nadeCare: 0.15, nadeHide: 3,   nadeAim: 5,   nadeCook: 0,    nadeLead: 0,   nadeFear: 0.25, medCare: 0.3,  medAt: 35, boostAt: 0,  medCancel: 0.3 },
    medium: { run: [0.3, 0.8],  stop: 0.12, tol: 0.75, shotErr: 1.8, react: 0.22, leadErr: 0.3,  track: 9,  dodge: 0.4,  qs: 0.5,  qsDelay: [0.15, 0.35], qsCare: false, reloadBoth: true,  closeMelee: 0.6,  charge: 0.05, gunSense: 0.55, reloadTo: 0.45, replan: 0.3,  seekAfter: 1,   losCare: 0.7,  panCare: 0.5,  panErr: 14, breakCare: 0.45, spare: 0.75, coverCare: 0.4, coverReach: 9,  sneakCare: 0.3, sneakAt: 0.45, sneakQuiet: 1.8, sneakReads: false, peekCare: 0.4, peekHide: [0.7, 1.4],  panRespect: 0.55, shieldCare: 0.5,  showerShots: 4, shieldHold: [0.6, 1.2], chargeRead: 0.45, chargeWeave: 0.3, reloadBack: 0.4,  hurtBack: 0.5, nadeCare: 0.4,  nadeHide: 2,   nadeAim: 3,   nadeCook: 0.3,  nadeLead: 0.4, nadeFear: 0.55, medCare: 0.55, medAt: 50, boostAt: 20, medCancel: 0.6 },
    high:   { run: [0.2, 0.55], stop: 0.05, tol: 0.5,  shotErr: 0.9, react: 0.14, leadErr: 0.15, track: 14, dodge: 0.7,  qs: 0.85, qsDelay: [0.08, 0.18], qsCare: true,  reloadBoth: true,  closeMelee: 0.85, charge: 0.08, gunSense: 0.85, reloadTo: 0.55, replan: 0.2,  seekAfter: 0.6, losCare: 0.95, panCare: 0.8,  panErr: 7,  breakCare: 0.7,  spare: 1,    coverCare: 0.8, coverReach: 13, sneakCare: 0.6, sneakAt: 0.65, sneakQuiet: 1.2, sneakReads: true,  peekCare: 0.8, peekHide: [0.5, 1],    panRespect: 0.85, shieldCare: 0.85, showerShots: 3, shieldHold: [0.7, 1.4], chargeRead: 0.85, chargeWeave: 0.8, reloadBack: 0.75, hurtBack: 0.8, nadeCare: 0.75, nadeHide: 1.3, nadeAim: 1.6, nadeCook: 0.7,  nadeLead: 0.8, nadeFear: 0.85, medCare: 0.85, medAt: 65, boostAt: 40, medCancel: 0.9 },
    pro:    { run: [0.12, 0.4], stop: 0.02, tol: 0.4,  shotErr: 0.5, react: 0.1,  leadErr: 0.08, track: 18, dodge: 0.95, qs: 1,    qsDelay: [0.03, 0.08], qsCare: true,  reloadBoth: true,  closeMelee: 1,    charge: 0.1,  gunSense: 1,    reloadTo: 0.67, replan: 0.12, seekAfter: 0.3, losCare: 1,    panCare: 1,    panErr: 3,  breakCare: 0.9,  spare: 1.5,  coverCare: 1,   coverReach: 18, sneakCare: 0.9, sneakAt: 0.85, sneakQuiet: 0.8, sneakReads: true,  peekCare: 1,   peekHide: [0.35, 0.7], panRespect: 0.95, shieldCare: 1,    showerShots: 3, shieldHold: [0.8, 1.6], chargeRead: 0.95, chargeWeave: 1,   reloadBack: 0.95, hurtBack: 1, nadeCare: 1,    nadeHide: 0.8, nadeAim: 0.8, nadeCook: 0.95, nadeLead: 1,   nadeFear: 1, medCare: 1,    medAt: 75, boostAt: 55, medCancel: 1 },
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
  // Melee distances follow the weapon's reach: its hit offset + hit radius + your radius (3.25 for fists).
  const MELEE_CLOSE = 0.25;           // "super close": within this much beyond its reach, it may go to melee
  const MELEE_SWING = 0.25;           // swings once you're this far inside its reach
  const MELEE_GIVE_UP = 2.25;         // you got away from a close-up fight, this far beyond its reach
  const MELEE_REROLL = 2.75;          // beyond this it rolls again as soon as you're super close
  const MELEE_FIGHT = [1.5, 3];       // s a close-up fight lasts
  const MELEE_RETRY = 1.5;            // s before it decides again if you stay super close
  const MELEE_BAND_MIN = 1.4;         // closest it gets while fighting with melee
  const MELEE_BAND_IN = 0.65;         // furthest it stays while fighting: this far inside its reach
  const MELEE_BAND_WIDTH = 1.55;      // a long weapon keeps you at the end of it: closest is this far inside that
  const CHARGE_DIST = 10;             // you're close enough for fists to charge
  const CHARGE_PER_REACH = 1.5;       // each unit of extra reach adds this much
  const FISTS_REACH = 3.25;
  const CHARGE_TIME = [1.2, 2.2];     // s before it gives up a charge
  const CHARGE_LOW_HP = 4;            // extra charge rate at 0 health, fading to none at full health
  const CHARGE_OPENING = 10;          // how much likelier a charge is while you can't shoot
  const CHARGE_SPEED = 10;            // units/s it can count on closing during a charge
  const CHARGE_SLACK = 0.15;          // s you may be ready before it arrives and it still counts as an opening
  const CHARGE_RECOVER = 2;           // units short of reach where it still calls off a charge you've recovered from
  const BACK_OFF = [17, 24];          // where it heads when it gives ground
  const BACK_OFF_FROM = 18;           // it's already far enough beyond this
  const HURT_AT = 0.55;               // share of its health where it thinks about backing off
  const RELOAD_INTERRUPT = 6;         // closer than this it fires whatever it has loaded, mid-reload or not
  // Turning the pan toward you while it can't shoot.
  const PAN_TURN = 3;                 // turning takes about this many "track" time constants
  const PAN_MIN_GAP = 0.15;           // s it must be able to hold the pan there, on top of turning both ways
  // Shooting out your cover: it only bothers when you're right behind the one obstacle in the way.
  const BREAK_NEAR = 4;               // units between you and the obstacle's edge
  // Reloading somewhere safe.
  const COVER_MIN_RELOAD = 0.6;       // s of reload left that make going to cover worthwhile
  const COVER_GAP = 0.25;             // units it stands from the obstacle
  const COVER_ARRIVED = 0.6;
  const COVER_MIN_FROM_YOU = 5;       // it won't hide somewhere this close to you
  const COVER_TRIP = 3;               // s it'll spend walking to cover before reloading a part-empty mag
  const COVER_TRIP_AT = 0.5;          // goes out of its way for this share of sneakAt
  const SNEAK_EVERY = [0.35, 0.6];    // s between checks
  const SNEAK_FAR = 12;               // in the open, it needs you at least this far away
  const SNEAK_IN_VIEW = 0.6;          // and its mag lower than this share of sneakAt
  const ATTACK_MARGIN = 0.5;          // units beyond its body that a shot of yours counts as aimed at it
  const ATTACK_LINGER = 0.4;          // s it still feels under attack after a shot passes or lands
  // Peeking from cover with a burst gun.
  const PEEK_EVERY = [0.8, 1.6];      // s between thinking of going to cover
  const PEEK_STAY = [6, 12];          // s it fights from one obstacle before it may move on
  const PEEK_BURSTS = [1, 2];         // bursts per peek
  const PEEK_OUT_MAX = 1.5;           // s it stays out if it can't get its shots off
  const PEEK_RETRY = 0.5;             // s until it tries again when neither side has a clear shot
  const PEEK_SIDE = 0.4;              // units past touching the obstacle it steps out
  // Shielding with its own pan while you spray it.
  const SHOWER_WINDOW = 0.6;          // s of your shots it remembers
  const SHOWER_LINGER = 0.8;          // s it stays shielded after the shots stop
  const SHOWER_NEAR = 1.5;            // units beyond its body that a shot still counts
  const SHIELD_PEEK_MAX = 0.6;        // s it stays turned toward you if it can't get its shot off
  // Waiting out a pan that faces it.
  const PAN_FACE_CONE = 0.6;          // radians either side of the pan that count as facing it
  const PAN_PROBE_EVERY = [1.5, 3.5]; // s between the occasional shots it still takes
  const PAN_PROBE_LEN = 0.25;         // s each lasts
  // Throwing grenades.
  const NADE_EVERY = [0.4, 0.8];      // s between checks
  const NADE_GAP = [3, 5];            // s after a throw before another, to see what that one did
  const NADE_NEAR = 8;                // closest it lands one to itself
  const NADE_FAR = 28;                // furthest it can reach, which is about the most a throw travels
  const NADE_WAIT = [0.05, 0.2];      // s between having it in hand and pulling the pin
  const NADE_RINGS = [0, 2, 3.5, 5];  // units from you it'll land one, when your cover blocks your spot
  const NADE_AROUND = 12;             // directions tried on each ring
  const NADE_READS = 0.25;            // how much likelier a throw is when you're hidden than when you're just reloading
  const NADE_MAX_COOK = 1.5;          // s it can burn off and still have it land first
  const NADE_REST = 1.478;            // a throw travels this many seconds' worth of its speed: 1.043 in the air + 1/drag rolling
  const NADE_RUN_FROM = 9;            // units from where it'll go off that it wants to be further than
  const NADE_NOTICE = 3.4;            // s of fuse left when it notices one, so a fresh throw isn't an instant reaction
  // Using healing and adrenaline items.
  const MED_EVERY = [0.3, 0.6];       // s between checks
  const MED_DANGER = 7;               // you this close is danger
  const MED_SEEN = 18;                // and in view within this, if it started out of your sight
  const MED_RETRY = [1.5, 3];         // s after calling one off before it thinks of it again
  const MED_LINGER = 0.4;             // s it stays behind cover after finishing
  const MED_TRIP_GAP = 3;             // s after a trip to cover before it tries another, if that one didn't work out
  const MED_BIG_BELOW = 45;           // health where it wants the med kit rather than a bandage
  const MED_PILLS_BELOW = 25;         // adrenaline where it wants pills rather than a soda
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
    // opts: { distance (units or 'dynamic'), rush, movement: 'strafe'|'wide'|'mixed', still, fire, skill, items,
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
      this.attacked = false;              // one of your shots is coming at it, or just hit it
      this.threatAge = 0;
      this.attackLinger = 0;
      this.lastHealth = player.health;
      this.peekT = 0;
      this.peeks = 0;                     // stats, used by the tests
      this.recentShots = [];              // { id, at } your shots coming its way
      this.showerT = 0;
      this.shield = false;                // shielding with its pan, peeking out for single shots
      this.shieldRolled = false;
      this.shieldPeek = false;
      this.shieldPeekIn = 0;
      this.shieldPeekT = 0;
      this.shieldAmmo = 0;
      this.panWait = false;               // holding fire because your pan faces it
      this.panFaced = false;
      this.panRespected = false;
      this.panProbeT = 0;
      this.panLag = 0;
      this.breakWant = false;             // decided to shoot out your cover if it can spare the bullets
      this.breaking = false;
      this.cover = null;                  // { o, trip, until } the obstacle it's reloading behind
      this.wasReloading = false;
      this.sneak = false;                 // this reload started with bullets still in the mag
      this.sneakT = 0;
      this.quietT = 0;                    // how long since you last had a shot in the air
      this.sneaks = 0;                    // stats, used by the tests
      this.coverUses = 0;
      this.medT = 2;
      this.medNoTrip = 0;
      this.medRolled = false;             // it has already decided about the danger it's in
      this.medHid = false;                // it started using this one out of your sight
      this.meds = 0;                      // stats, used by the tests
      this.medCancels = 0;
      this.nade = null;                   // a grenade throw in progress
      this.nadeT = 1.5;
      this.nadeThrows = 0;                // stats, used by the tests
      this.nadeRuns = 0;
      this.nadeSeen = new WeakMap();      // grenade -> will it run from this one?
      this.chargeReads = false;           // this charge watches for you recovering
      this.chargeWeaves = false;
      this.hurtRolled = false;
      this.panCovering = false;
      this.panRolled = false;
      this.panOff = 0;
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
      if (this.p.cur === 2 && this.fightMelee()) return this.meleeBand();
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

    // Gives ground while it can't fight well: reloading, or hurt.
    backOff(dist) {
      if (!this.dynamic || this.mode !== 'hold' || dist > BACK_OFF_FROM) return;
      this.setGoal(rand(BACK_OFF[0], BACK_OFF[1]));
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
      // A weaving charge takes the diagonals toward you, never the straight line.
      if (this.charge && this.chargeWeaves && d > hi) { want = -0.65; tol = 0.3; }
      else if (this.mode === 'rush' || (this.p.cur === 2 && this.fightMelee() && d > hi)) want = -0.9;
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

    meleeReach() {
      const d = SV.defOf(this.p.slots[2].type);
      return d ? Math.hypot(d.attack.offset.x, d.attack.offset.y) + d.attack.rad + this.t.rad : FISTS_REACH;
    }

    meleeBand() {
      const far = this.meleeReach() - MELEE_BAND_IN;
      return [Math.max(MELEE_BAND_MIN, far - MELEE_BAND_WIDTH), far];
    }

    // How long until the gun it's holding, or going back to, can fire.
    timeToFire() {
      const p = this.p, slot = p.cur === 2 ? p.lastGun : p.cur, w = p.slots[slot], d = SV.defOf(w.type);
      if (!d || d.kind !== 'gun') return 0;
      if (p.reloading && slot === p.cur) {
        const shells = d.maxReload < d.maxClip && p.action.type !== 'alt' ? Math.max(1, this.enoughAmmo(d) - w.ammo) : 1;
        return p.action.duration * shells - p.action.time;
      }
      return Math.max(0, w.cooldown);
    }

    // With a pan on its back, or in its hand between shots, it can turn it toward you while it can't shoot.
    // It decides once per gap, and turns back in time for the next shot. Returns how far to turn from
    // facing you (radians), or null. player.panSegmentAt: a point at local (x, y) sits at atan2(-y, x) from facing.
    panCover(dist) {
      const p = this.p, S = this.S;
      if (p.slots[2].type !== 'pan') return null;
      const panAngle = () => {
        const s = SV.MELEE.pan.reflectSurface[p.wearingPan ? 'unequipped' : 'equipped'];
        return -Math.atan2(-(s.p0.y + s.p1.y) / 2, (s.p0.x + s.p1.x) / 2) + this.panOff;
      };
      if (this.shield) return this.shieldPeek || dist < this.meleeReach() + MELEE_CLOSE ? null : panAngle();
      const turn = PAN_TURN / S.track, wait = this.timeToFire();
      // On the way in with the pan out, it holds it toward you, and turns to swing just before it arrives.
      if (this.charge && p.cur === 2) {
        if (!this.panRolled) {
          this.panRolled = true;
          this.panCovering = Math.random() < S.panCare;
          this.panOff = (gauss() * S.panErr * Math.PI) / 180;
        }
        return this.panCovering && dist > this.meleeReach() + CHARGE_SPEED * turn ? panAngle() : null;
      }
      if (wait < turn || dist < this.meleeReach() + MELEE_CLOSE || this.sightBlocked || (p.cur === 2 && this.fightMelee())) {
        this.panCovering = this.panRolled = false;
        return null;
      }
      if (!this.panRolled && wait > 2 * turn + PAN_MIN_GAP) {
        this.panRolled = true;
        this.panCovering = Math.random() < S.panCare;
        this.panOff = (gauss() * S.panErr * Math.PI) / 180;
      }
      return this.panCovering ? panAngle() : null;
    }

    // Shots a gun needs before the bot stops reloading it. A shell-by-shell gun would otherwise fire
    // the first shell in, which cancels the reload and leaves it on an almost empty gun.
    enoughAmmo(d) { return d.maxReload >= d.maxClip ? d.maxClip : Math.ceil(d.maxClip * this.S.reloadTo); }

    // How long until you could shoot it, with either gun: reloading, a shot's delay, or the swap to the other one.
    youCanFireIn() {
      const t = this.t;
      if (!t.slots) return 0;
      let best = Infinity;
      [0, 1].forEach((k) => {
        const s = t.slots[k], d = SV.defOf(s.type);
        if (!d || d.kind !== 'gun' || s.ammo <= 0) return;
        if (t.cur === k) best = Math.min(best, Math.max(0, s.cooldown));
        else best = Math.min(best, t.freeSwitchTimer < 0 ? C.player.baseSwitchDelay : d.switchDelay);
      });
      if (best === Infinity) {                 // nothing loaded: however long the reload has left, or a guess at one
        const d = t.activeDef;
        return t.reloading ? t.action.duration - t.action.time : d && d.kind === 'gun' ? d.reloadTime : 1;
      }
      return t.reloading && t.cur < 2 && t.slots[t.cur].ammo <= 0 ? Math.max(best, 0.1) : best;
    }
    // You can't shoot before it gets there.
    hasOpening(dist) { return this.youCanFireIn() + CHARGE_SLACK >= Math.max(0, dist - this.meleeReach()) / CHARGE_SPEED; }

    // Decides on melee: when you're super close, and sometimes a charge when you're close, more
    // often the lower its health. A bot set to never rush doesn't charge. Better bots wait for an opening
    // rather than running at a loaded gun, and call the charge off if you recover while they're still out of reach.
    meleeThinking(dist, dt) {
      const p = this.p, S = this.S;
      if (!p.slots[2].type) return;
      this.closeFightT -= dt;
      this.closeNext -= dt;
      const reach = this.meleeReach(), close = reach + MELEE_CLOSE;
      if (dist > reach + MELEE_GIVE_UP) this.closeFightT = 0;
      if (dist > reach + MELEE_REROLL) this.closeNext = 0;
      if (dist < close && this.closeNext <= 0 && !this.charge) {
        const go = Math.random() < S.closeMelee;
        this.closeFightT = go ? rand(MELEE_FIGHT[0], MELEE_FIGHT[1]) : 0;
        this.closeNext = this.closeFightT + MELEE_RETRY;
        if (go) this.meleeIn = rand(S.qsDelay[0], S.qsDelay[1]);
      }
      if (this.charge && this.chargeReads && dist > reach + CHARGE_RECOVER && !this.hasOpening(dist)) {
        this.endFight();
        this.closeFightT = 0;
        return;
      }
      if (this.mode === 'hold' && this.o.rush !== 'never' && !(this.cover && !this.cover.peek) && dist >= close && dist < CHARGE_DIST + (reach - FISTS_REACH) * CHARGE_PER_REACH) {
        const hurt = 1 - Math.max(0, p.health) / C.player.health;
        const reads = Math.random() < S.chargeRead, open = this.hasOpening(dist);
        if (reads && !open) return;            // waits
        if (Math.random() < S.charge * (1 + CHARGE_LOW_HP * hurt) * (open ? CHARGE_OPENING : 1) * dt) {
          this.charge = true; this.charges++;
          this.chargeReads = Math.random() < S.chargeRead;
          this.chargeWeaves = Math.random() < S.chargeWeave;
          this.panRolled = false;
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
      if (w.ammo === 0 && this.reloadSlot !== p.cur && !p.reloading) {
        // Behind the pan it has time to reload the single-shot gun instead of going back to spraying.
        if (this.swapT == null && this.shield && d.fireMode === 'single') { this.reloadSlot = p.cur; return; }
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
      // Shielding: one careful shot at a time suits a single-shot gun, if it has one.
      const od = SV.defOf(o.type);
      if (this.shield && d.fireMode !== 'single' && od && od.fireMode === 'single' && o.ammo > 0 && !p.bursts.length && !p.reloading) {
        this.qsT = null; this.spraying = false;
        p.switchTo(other);
        return;
      }
      // Better players follow one reload with the other gun's, or they lose the quickswitch.
      if (S.reloadBoth && this.topUp && w.ammo >= this.enoughAmmo(d) && o.ammo === 0) {
        this.topUp = false; this.reloadSlot = other; this.qsT = null; this.spraying = false;
        p.switchTo(other);
        return;
      }
      const cost = p.freeSwitchTimer < 0 ? C.player.baseSwitchDelay : SV.defOf(o.type).switchDelay;
      // Behind the pan it waits out a single-shot gun's delay rather than changing to something that would spray.
      const keepSingle = this.shield && d.fireMode === 'single' && od && od.fireMode !== 'single';
      if (this.qsT != null && (this.qsT -= dt) <= 0) {
        if (o.ammo <= 0 || p.bursts.length || keepSingle) { this.qsT = null; return; }
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
        if (this.preferredSlot(dist) === other && !keepSingle && o.ammo > 0 && !p.reloading && !p.bursts.length && this.reloadSlot == null
            && (!S.qsCare || cost <= Math.max(w.cooldown, C.player.baseSwitchDelay)) && Math.random() < S.gunSense) {
          this.qsT = null; this.spraying = false;
          p.switchTo(other);
        }
      }
    }

    // Somewhere to land a grenade that reaches you: your own spot, or as close as it can get with a clear throw from
    // here and nothing between there and you that stops a blast. A low rock stops neither, so that's your spot.
    nadeSpot() {
      const p = this.p, t = this.t, f = p.world.field;
      for (const r of NADE_RINGS) {
        for (let k = 0; k < (r ? NADE_AROUND : 1); k++) {
          const a = (k / NADE_AROUND) * Math.PI * 2, c = { x: t.pos.x + Math.cos(a) * r, y: t.pos.y + Math.sin(a) * r };
          const d = Math.hypot(c.x - p.pos.x, c.y - p.pos.y);
          if (d < NADE_NEAR || d > NADE_FAR) continue;
          if (!f || (!f.tallBetween(p.pos, c) && !f.tallBetween(c, t.pos))) return c;
        }
      }
      return null;
    }

    // What it needs most, if anything. The long ones are for when it's properly out of sight.
    medItem(hidden) {
      const p = this.p, S = this.S;
      if (p.health <= S.medAt) return p.health < MED_BIG_BELOW && hidden ? 'healthkit' : 'bandage';
      // Topping up can wait while it's got a grenade to flush you out with.
      if (p.nades > 0 && this.noSightT > S.nadeHide) return null;
      if (p.boost < S.boostAt) return p.boost < MED_PILLS_BELOW && hidden ? 'painkiller' : 'soda';
      return null;
    }

    // Heals and drinks where you can't get at it: behind cover if there's any, otherwise far away and left alone.
    // It stops if you come for it, or it's under fire, unless it's too new at this to notice in time.
    // True while it has an item out, when its hands are full.
    medThinking(dist, dt) {
      const p = this.p, S = this.S, world = p.world;
      if (!this.o.items) return false;
      if (p.action && p.action.type === 'use') {
        if (this.cover && this.cover.med) this.cover.until = world.time + MED_LINGER;
        const danger = this.attacked || dist < MED_DANGER || (this.medHid && !this.sightBlocked && dist < MED_SEEN);
        if (danger && !this.medRolled) {
          this.medRolled = true;
          if (Math.random() < S.medCancel) {
            p.cancelAction();
            this.medCancels++;
            this.medT = rand(MED_RETRY[0], MED_RETRY[1]);
            return false;
          }
        }
        return true;
      }
      // A reload on the way doesn't use up its time behind the cover it came for.
      if (this.cover && this.cover.med && (p.reloading || p.reloadAgain || this.reloadSlot != null)) this.cover.until = Math.max(this.cover.until, world.time + MED_LINGER);
      if (this.nade || (this.medT -= dt) > 0) return false;
      this.medT = rand(MED_EVERY[0], MED_EVERY[1]);
      if (this.mode !== 'hold' || this.fightMelee() || this.shield || this.attacked || p.cur >= 2 || p.reloading || p.reloadAgain || this.reloadSlot != null || p.bursts.length || p.cooking) return false;
      const hidden = this.sightBlocked, item = this.medItem(hidden);
      if (!item || Math.random() >= S.medCare) return false;
      // Out in the open it goes for cover first, if there's any to reach and it hasn't just tried.
      if (!hidden && world.field && !this.o.still && !this.cover && world.time > this.medNoTrip && Math.random() < S.coverCare) {
        this.startCover(false);
        if (this.cover) {
          this.cover.med = true;
          this.cover.until = world.time + COVER_TRIP;
          this.medNoTrip = this.cover.until + MED_TRIP_GAP;
          return false;
        }
      }
      if (!hidden && this.cover) return false;   // on its way
      if (hidden || (this.quietT > S.sneakQuiet && dist > SNEAK_FAR)) {
        if (!p.useItem(item)) return false;
        this.medRolled = false; this.medHid = hidden; this.meds++;
        this.spraying = false; this.qsT = null;
        return true;
      }
      this.backOff(dist);
      return false;
    }

    // Flushes you out with a grenade when you've been out of sight a while, or now and then when you're reloading.
    // True while a throw is under way, which is when its hands are full. It has to cook and throw like you do.
    grenadeThinking(dist, dt) {
      const p = this.p, t = this.t, S = this.S, n = this.nade;
      if (n) {
        n.t += dt;
        if (p.nades < n.had || (n.phase !== 'thrown' && p.nades <= 0)) n.phase = 'thrown';
        if (n.phase === 'ready' && n.t >= n.wait) n.phase = 'cooking';
        if (n.phase === 'thrown' && p.throwCooldown <= 0) {
          if (p.cur === 3) p.switchTo(n.back);
          this.nade = null;
          return false;
        }
        return true;
      }
      if (p.nades <= 0 || (this.nadeT -= dt) > 0) return false;
      this.nadeT = rand(NADE_EVERY[0], NADE_EVERY[1]);
      if (this.mode !== 'hold' || this.fightMelee() || this.cover || this.shield || p.reloading || p.reloadAgain || this.reloadSlot != null || p.bursts.length || p.throwCooldown > 0 || p.cur >= 2) return false;
      const hidden = this.noSightT > S.nadeHide;
      if (!hidden && !t.reloading) return false;
      if (Math.random() >= S.nadeCare * (hidden ? 1 : NADE_READS)) return false;
      const spot = this.nadeSpot();
      if (!spot) return false;
      this.nadeThrows++;
      this.nadeT = rand(NADE_GAP[0], NADE_GAP[1]);
      this.spraying = false; this.qsT = null;
      const off = gauss() * S.nadeAim, a = Math.random() * Math.PI * 2;
      this.nade = { x: spot.x + Math.cos(a) * off, y: spot.y + Math.sin(a) * off, phase: 'ready', t: 0, wait: rand(NADE_WAIT[0], NADE_WAIT[1]), back: p.cur, had: p.nades, cook: S.nadeCook * NADE_MAX_COOK };
      p.switchTo(3);
      return true;
    }

    // Where its hand has to go, and how hard, for the throw to end up on the spot: moving adds to a throw (projectile.ts).
    nadeThrowAngle() {
      const p = this.p, n = this.nade, P = SV.FRAG.throwPhysics, lead = this.S.nadeLead * P.playerVelMult;
      const vx = (n.x - p.pos.x) / NADE_REST - p.moveVx * lead, vy = (n.y - p.pos.y) / NADE_REST - p.moveVy * lead;
      p.toMouseLen = (Math.hypot(vx, vy) / P.speed) * C.player.throwableMaxMouseDist;
      return Math.atan2(vy, vx);
    }

    // Gets clear of a grenade that's about to go off near it. Not everyone's that careful.
    checkGrenades() {
      const p = this.p, world = p.world;
      if (this.o.still || !world || !world.projectiles.length) return;
      for (const g of world.projectiles) {
        if (g.fuse > NADE_NOTICE) continue;
        // where it'll be when it goes off: rolling slows it to a stop
        const left = Math.max(0, g.fuse), travel = g.z > g.below ? left : (1 - Math.exp(-2.3 * left)) / 2.3;
        const bx = g.pos.x + g.vel.x * travel, by = g.pos.y + g.vel.y * travel;
        const dx = p.pos.x - bx, dy = p.pos.y - by, d = Math.hypot(dx, dy) || 1;
        if (d > NADE_RUN_FROM) continue;
        if (!this.nadeSeen.has(g)) { this.nadeSeen.set(g, Math.random() < this.S.nadeFear); this.nadeRuns++; }
        if (!this.nadeSeen.get(g)) continue;
        let best = this.dirIdx, bestAway = -2;
        DIRS.forEach((v, k) => {
          const away = (v.x * dx + v.y * dy) / d - (this.runsIntoObstacle(v) ? 1 : 0);
          if (away > bestAway) { bestAway = away; best = k; }
        });
        this.dirIdx = best;
        this.dirT = 0.25; this.dodgeT = 0.25;
        return;
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
      if (blocked && !this.sightBlocked) {
        this.shootBlind = Math.random() > this.S.losCare;
        this.breakWant = this.o.fire && Math.random() < this.S.breakCare;
      }
      this.sightBlocked = blocked;
      this.breaking = blocked && this.breakWant && this.canBreak(f);
      this.noSightT = blocked ? this.noSightT + dt : 0;
    }

    // Worth shooting out? You have to be right behind the only obstacle in the way, the mag has to hold enough
    // to break it, and what's left in both guns has to be enough to still finish you.
    canBreak(f) {
      const p = this.p, t = this.t, d = p.activeDef, S = this.S;
      if (d.kind !== 'gun' || p.reloading) return false;
      const list = f.blockers(p.pos, t.pos);
      if (list.length !== 1) return false;
      const o = list[0];
      if (Math.hypot(o.x - t.pos.x, o.y - t.pos.y) - o.r > BREAK_NEAR) return false;
      const ammo = p.slots[p.cur].ammo, hit = d.bullet.damage * d.bulletCount;
      const needed = Math.ceil(o.health / (hit * d.bullet.obstacleDamage));
      if (needed > ammo) return false;
      const other = p.slots[p.cur === 0 ? 1 : 0], od = SV.defOf(other.type);
      const left = (ammo - needed) * hit + (od && od.kind === 'gun' ? other.ammo * od.bullet.damage * od.bulletCount : 0);
      return left >= t.health * S.spare;
    }

    // The closest spot with an obstacle between it and you.
    findCover() {
      const p = this.p, t = this.t, f = p.world && p.world.field, reach = this.S.coverReach;
      if (!f) return null;
      const view = this.o.view && this.o.view();
      let best = null, bestD = Infinity;
      for (const o of f.near(p.pos.x, p.pos.y, reach + 3)) {
        if (o.dead) continue;
        const s = this.coverSpot(o), d = Math.hypot(s.x - p.pos.x, s.y - p.pos.y);
        if (d > reach || d >= bestD || Math.hypot(s.x - t.pos.x, s.y - t.pos.y) < COVER_MIN_FROM_YOU) continue;
        if (view && (Math.abs(s.x - t.pos.x) > view.hw || Math.abs(s.y - t.pos.y) > view.hh)) continue;
        if (!f.isFree(s.x, s.y, p.rad) || !f.blocked(s, t.pos)) continue;
        bestD = d; best = o;
      }
      return best;
    }

    coverSpot(o) {
      const dx = o.x - this.t.pos.x, dy = o.y - this.t.pos.y, d = Math.hypot(dx, dy) || 1, r = o.r + this.p.rad + COVER_GAP;
      return { x: o.x + (dx / d) * r, y: o.y + (dy / d) * r };
    }

    startCover(trip) {
      const o = this.findCover();
      if (!o) return;
      this.cover = { o, trip, until: trip ? this.p.world.time + COVER_TRIP : Infinity };
      this.coverUses++;
      this.path = null; this.planT = 0;
    }

    // Reloads when it feels safe, even with bullets left, and heads for cover to do it. Safe means you can't
    // see it, you're reloading (if it's good enough to notice), or you're far away and haven't fired lately.
    reloadThinking(dist, dt) {
      const p = this.p, t = this.t, S = this.S, world = p.world, f = world && world.field;
      if (world && world.bullets.some((b) => b.alive && b.owner === t)) this.quietT = 0; else this.quietT += dt;
      if (p.cur === 2 || this.mode !== 'hold' || this.fightMelee()) { this.cover = null; this.wasReloading = false; return; }
      const w = p.slots[p.cur], d = p.activeDef;
      if (d.kind !== 'gun') return;
      const reloading = !!(p.reloading || p.reloadAgain);
      if (!reloading) this.sneak = false;
      if (f && !this.o.still) {
        if (reloading && !this.wasReloading && !this.cover && this.timeToFire() > COVER_MIN_RELOAD && Math.random() < S.coverCare) this.startCover(false);
        if (this.cover) {
          const c = this.cover, s = c.o.dead ? null : this.coverSpot(c.o), there = s && Math.hypot(s.x - p.pos.x, s.y - p.pos.y) < COVER_ARRIVED;
          if (!s || (c.med ? world.time > c.until : c.peek ? (world.time > c.until && !reloading) || d.fireMode !== 'burst'
            : c.trip ? world.time > c.until : !reloading && !this.reloadSlot)) {
            if (c.peek) this.peekT = rand(PEEK_EVERY[0], PEEK_EVERY[1]);
            this.cover = null;
          }
          else if (c.trip && there && w.cooldown <= 0) {
            this.cover = null;
            if (w.ammo < d.maxClip) { this.sneak = true; this.sneaks++; this.qsT = null; this.spraying = false; p.requestReload(); }
          }
        }
      }
      if (reloading && !this.wasReloading && !this.cover && !this.fightMelee() && Math.random() < S.reloadBack) this.backOff(dist);
      this.wasReloading = reloading;
      // A burst gun fights from behind something: see peekStep.
      if (f && !this.o.still && !this.cover && !reloading && d.fireMode === 'burst' && (this.peekT -= dt) <= 0) {
        this.peekT = rand(PEEK_EVERY[0], PEEK_EVERY[1]);
        if (Math.random() < S.peekCare) {
          const spot = this.findCover();
          if (spot) {
            this.cover = { o: spot, peek: true, until: world.time + rand(PEEK_STAY[0], PEEK_STAY[1]), out: false, t: 0, side: 1, bursts: 1, ammo: 0 };
            this.peeks++;
            this.path = null; this.planT = 0;
          }
        }
      }
      if ((this.sneakT -= dt) > 0) return;
      this.sneakT = rand(SNEAK_EVERY[0], SNEAK_EVERY[1]);
      if (reloading || this.breaking || p.bursts.length || p.action) return;
      const full = w.ammo / d.maxClip;
      const hidden = this.sightBlocked, reads = S.sneakReads && !!t.reloading;
      const calm = this.quietT > S.sneakQuiet && dist > SNEAK_FAR && !this.spraying && this.qsT == null;
      const quiet = calm && full <= S.sneakAt * SNEAK_IN_VIEW;
      const safe = hidden || reads || quiet || (S.sneakReads && this.panWait) || this.shield;
      // An empty gun comes first, or it could keep topping up one gun and never use the other again.
      const other = p.cur === 0 ? 1 : 0, o = p.slots[other], od = SV.defOf(o.type);
      if (od && od.kind === 'gun' && o.ammo === 0 && S.reloadBoth && w.ammo > 0 && (hidden || reads || (calm && full <= S.sneakAt)) && Math.random() < S.sneakCare) {
        this.reloadSlot = other; this.topUp = false; this.qsT = null; this.spraying = false;
        p.switchTo(other);
        return;
      }
      if (w.cooldown <= 0 && w.ammo > 0 && w.ammo < d.maxClip && full <= S.sneakAt && safe && Math.random() < S.sneakCare) {
        this.qsT = null; this.spraying = false; this.sneak = true; this.sneaks++;
        p.requestReload();
        return;
      }
      // Topped up and still hidden: the other gun's turn.
      if (hidden && S.reloadBoth && od && od.kind === 'gun' && w.ammo >= d.maxClip && o.ammo < this.enoughAmmo(od) && o.ammo < d.maxClip * S.sneakAt && Math.random() < S.sneakCare) {
        this.reloadSlot = other; this.topUp = false; this.qsT = null; this.spraying = false;
        p.switchTo(other);
        return;
      }
      if (f && !this.o.still && !this.cover && w.ammo > 0 && full <= S.sneakAt * COVER_TRIP_AT && !safe && Math.random() < S.coverCare * S.sneakCare) this.startCover(true);
    }

    // Beside the obstacle, on one side, where it can see you.
    peekSpot(o, side) {
      const dx = o.x - this.t.pos.x, dy = o.y - this.t.pos.y, d = Math.hypot(dx, dy) || 1, r = o.r + this.p.rad + PEEK_SIDE;
      return { x: o.x - (dy / d) * r * side, y: o.y + (dx / d) * r * side };
    }

    // The nearer side with a clear shot at you, or 0 if neither has one.
    peekSide(o) {
      const p = this.p, f = p.world.field;
      const ok = [1, -1].filter((side) => { const s = this.peekSpot(o, side); return f.isFree(s.x, s.y, p.rad) && !f.blocked(s, this.t.pos); });
      if (ok.length < 2) return ok[0] || 0;
      const d = (side) => { const s = this.peekSpot(o, side); return Math.hypot(s.x - p.pos.x, s.y - p.pos.y); };
      return d(ok[0]) <= d(ok[1]) ? ok[0] : ok[1];
    }

    // Hide, step out to one side, fire a burst or two, step back, and repeat.
    peekStep(dt) {
      const p = this.p, c = this.cover, w = p.slots[p.cur], d = p.activeDef, hide = this.coverSpot(c.o);
      if (p.reloading || p.reloadAgain) { c.out = false; return hide; }
      c.t -= dt;
      if (!c.out) {
        if (c.t > 0 || !this.sightBlocked) return hide;
        const side = this.peekSide(c.o);
        if (!side) { c.t = PEEK_RETRY; return hide; }
        c.out = true; c.side = side; c.t = PEEK_OUT_MAX; c.ammo = w.ammo;
        c.bursts = PEEK_BURSTS[0] + Math.floor(Math.random() * (PEEK_BURSTS[1] - PEEK_BURSTS[0] + 1));
        this.path = null; this.planT = 0;
        return this.peekSpot(c.o, side);
      }
      if ((c.ammo - w.ammo >= (d.burstCount || 1) * c.bursts && !p.bursts.length) || c.t <= 0) {
        c.out = false; c.t = rand(this.S.peekHide[0], this.S.peekHide[1]);
        this.path = null; this.planT = 0;
        return hide;
      }
      return this.peekSpot(c.o, c.side);
    }

    // One of your shots coming straight at it, or one that just landed. It takes its reaction time to notice.
    threatThinking(dt) {
      const p = this.p, t = this.t, world = p.world;
      const hurt = p.health < this.lastHealth;
      this.lastHealth = p.health;
      let incoming = false;
      if (world) for (const b of world.bullets) {
        if (!b.alive || b.owner !== t) continue;
        const rx = p.pos.x - b.pos.x, ry = p.pos.y - b.pos.y, along = rx * b.dir.x + ry * b.dir.y;
        if (along > 0 && along <= b.distance - b.traveled + p.rad && Math.abs(rx * b.dir.y - ry * b.dir.x) <= p.rad + ATTACK_MARGIN) { incoming = true; break; }
      }
      this.threatAge = incoming || hurt ? this.threatAge + dt : Math.max(0, this.threatAge - dt);   // a stream of fast shots adds up
      if (hurt || this.threatAge >= this.S.react) this.attackLinger = ATTACK_LINGER;
      else this.attackLinger -= dt;
      this.attacked = this.attackLinger > 0;
    }

    // You're spraying it and it has a pan: it keeps the pan toward you and turns out for one shot at a time.
    shieldThinking(dt) {
      const p = this.p, t = this.t, S = this.S, world = p.world;
      if (!world || p.slots[2].type !== 'pan') return;
      const now = world.time;
      for (const b of world.bullets) {
        if (b.owner !== t || b.reflectCount || now - b.born > SHOWER_WINDOW || this.recentShots.some((r) => r.id === b.shotId)) continue;
        const rx = p.pos.x - b.start.x, ry = p.pos.y - b.start.y;
        if (rx * b.dir.x + ry * b.dir.y > 0 && Math.abs(rx * b.dir.y - ry * b.dir.x) <= p.rad + SHOWER_NEAR) this.recentShots.push({ id: b.shotId, at: b.born });
      }
      this.recentShots = this.recentShots.filter((r) => now - r.at <= SHOWER_WINDOW);
      this.showerT = this.recentShots.length >= S.showerShots ? SHOWER_LINGER : this.showerT - dt;
      if (this.showerT <= 0 || this.mode !== 'hold' || this.fightMelee() || this.sightBlocked) {
        this.shield = this.shieldRolled = this.shieldPeek = false;
        return;
      }
      if (!this.shieldRolled) {
        this.shieldRolled = true;
        this.shield = Math.random() < S.shieldCare;
        this.panOff = (gauss() * S.panErr * Math.PI) / 180;
        this.shieldPeekIn = rand(S.shieldHold[0], S.shieldHold[1]);
        if (this.shield) this.spraying = false;
      }
      if (!this.shield || p.cur === 2) return;
      const w = p.slots[p.cur];
      if (this.shieldPeek) {
        if (w.ammo < this.shieldAmmo || (this.shieldPeekT -= dt) <= 0) {
          this.shieldPeek = false; this.spraying = false;
          this.shieldPeekIn = rand(S.shieldHold[0], S.shieldHold[1]);
        }
      } else if ((this.shieldPeekIn -= dt) <= 0 && w.ammo > 0 && !p.reloading && this.timeToFire() <= PAN_TURN / S.track) {
        this.shieldPeek = true; this.shieldPeekT = SHIELD_PEEK_MAX; this.shieldAmmo = w.ammo;
      }
    }

    // Your pan facing it, in your hand or on your back. Shots would come straight back, so it mostly waits
    // for an opening, with an occasional shot. It takes its reaction time to notice you've turned.
    panThinking(dt) {
      const p = this.p, t = this.t, S = this.S;
      let faced = false;
      if (t.hasActivePan && t.hasActivePan()) {
        const s = SV.MELEE.pan.reflectSurface[t.wearingPan ? 'unequipped' : 'equipped'];
        let a = Math.atan2(t.dir.y, t.dir.x) + Math.atan2(-(s.p0.y + s.p1.y) / 2, (s.p0.x + s.p1.x) / 2) - Math.atan2(p.pos.y - t.pos.y, p.pos.x - t.pos.x);
        while (a > Math.PI) a -= 2 * Math.PI;
        while (a < -Math.PI) a += 2 * Math.PI;
        faced = Math.abs(a) < PAN_FACE_CONE;
      }
      if (!faced) {
        if (this.panFaced) { this.panFaced = false; this.panLag = S.react; }
        this.panLag -= dt;
        this.panWait = this.panRespected && this.panLag > 0;
        return;
      }
      if (!this.panFaced) {
        this.panFaced = true;
        this.panRespected = Math.random() < S.panRespect;
        this.panProbeT = rand(PAN_PROBE_EVERY[0], PAN_PROBE_EVERY[1]);
      }
      this.panProbeT -= dt;
      if (this.panProbeT <= -PAN_PROBE_LEN) this.panProbeT = rand(PAN_PROBE_EVERY[0], PAN_PROBE_EVERY[1]);
      this.panWait = this.panRespected && this.panProbeT > 0;
    }

    // Walks to the spot behind its cover and waits there. The spot moves as you do.
    walkCover(dt) {
      const p = this.p, c = this.cover, f = p.world.field, s = c.peek ? this.peekStep(dt) : this.coverSpot(c.o);
      const left = Math.hypot(s.x - p.pos.x, s.y - p.pos.y);
      if (left < COVER_ARRIVED) { this.dirIdx = -1; this.path = null; return true; }
      if ((this.planT -= dt) <= 0 || !this.path) {
        this.planT = this.S.replan;
        this.path = f.findPath(p.pos, s, p.rad, COVER_GAP - 0.05, 1);
        this.pathI = 0;
      }
      this.followPath(s);
      return true;
    }

    // Heads for the next waypoint, then straight for the goal if one is given.
    followPath(goal) {
      const p = this.p;
      while (this.path && this.pathI < this.path.length && Math.hypot(this.path[this.pathI].x - p.pos.x, this.path[this.pathI].y - p.pos.y) < WAYPOINT_REACHED) this.pathI++;
      const atEnd = !this.path || this.pathI >= this.path.length;
      if (atEnd && !goal) { this.path = null; return false; }
      const w = atEnd ? goal : this.path[this.pathI], dx = w.x - p.pos.x, dy = w.y - p.pos.y, d = Math.hypot(dx, dy) || 1;
      let best = 0, bestDot = -2;
      DIRS.forEach((v, k) => { const q = (v.x * dx + v.y * dy) / d; if (q > bestDot) { bestDot = q; best = k; } });
      this.dirIdx = best;
      return true;
    }

    // Walks a path around obstacles when one is in the way of getting to you, or when it's lost sight of you
    // for long enough. Otherwise normal movement carries on. True while it's following a path.
    navigate(dist, dt) {
      const p = this.p, t = this.t, f = p.world && p.world.field;
      if (!f || this.o.still) return false;
      if (this.cover) return this.walkCover(dt);
      const closing = this.mode === 'rush' || dist > this.range()[1];
      const seeking = this.noSightT > this.S.seekAfter;
      if (this.breaking && this.mode !== 'rush') { this.path = null; return false; }   // staying put to shoot it out
      if (!(closing || seeking) || !f.blocked(p.pos, t.pos, p.rad + NAV_CLEAR)) { this.path = null; return false; }
      if ((this.planT -= dt) <= 0 || !this.path) {
        this.planT = this.S.replan;
        this.path = f.findPath(p.pos, t.pos, p.rad, NAV_CLEAR);
        this.pathI = 0;
      }
      if (!this.path) return false;
      return this.followPath(null);
    }

    // Long runs can overshoot a narrow band or the screen edge, so a dynamic bot turns early.
    offCourse(dist) {
      // In a melee fight, turn back as soon as it's moving out of reach.
      if (this.p.cur === 2 && this.fightMelee() && this.dirIdx >= 0 && dist > this.meleeBand()[1]) {
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
      if (this.mode === 'hold' && (this.rushIn -= dt) <= 0 && !(this.cover && !this.cover.peek)) {
        this.mode = 'rush'; this.dirT = 0;
        this.modeT = rand(RUSH_GIVE_UP[0], RUSH_GIVE_UP[1]) + Math.max(0, dist - RUSH_GIVE_UP_DIST) / RUSH_APPROACH_SPEED;
      }
      if (this.mode === 'rush') {
        if (dist < this.meleeReach() - MELEE_SWING) { this.mode = 'brawl'; this.modeT = rand(1.2, 2.5); this.dirT = 0; }
        else if ((this.modeT -= dt) <= 0) this.endFight();   // you got away
      }
      if (this.mode === 'brawl' && (this.modeT -= dt) <= 0) this.endFight();
      if (this.o.fire && !this.hurtRolled && p.health < C.player.health * HURT_AT) {
        this.hurtRolled = true;
        if (!this.charge && Math.random() < S.hurtBack) this.backOff(dist);
      } else if (p.health >= C.player.health * HURT_AT) this.hurtRolled = false;
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
      this.checkGrenades();
      if (this.offCourse(dist)) this.dirT = 0;
      this.checkSight(dt);
      if (this.o.fire) { this.threatThinking(dt); this.shieldThinking(dt); this.panThinking(dt); this.reloadThinking(dist, dt); }
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

      const using = this.o.fire && this.medThinking(dist, dt);
      const throwing = this.o.fire && !using && this.grenadeThinking(dist, dt);
      if (this.o.fire && !throwing && !using) { this.meleeThinking(dist, dt); this.gunSwitching(dt, dist); }

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
      let want = throwing ? this.nadeThrowAngle() : Math.atan2(ay - p.pos.y, ax - p.pos.x);
      const cover = this.o.fire && !throwing && !using ? this.panCover(dist) : null;
      if (cover != null) { want += cover; this.spraying = false; }
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
      if (throwing) {
        const n = this.nade;
        if (n.phase === 'cooking') {
          if (!p.cooking) i.shootStart = true;
          i.shootHold = p.cookT < n.cook && dist >= NADE_NEAR / 2;   // lets go early if you've run up to it
        }
      } else if (this.o.fire && !using && !t.dead) {
        const inRange = d.kind === 'gun' ? dist < d.bullet.distance * 0.9 : dist < this.meleeReach() - MELEE_SWING;
        const onTarget = Math.abs(diff) < Math.max(0.05, Math.atan2(t.rad * 1.5, dist));
        const isAuto = d.kind === 'gun' && (d.fireMode === 'auto' || d.fireMode === 'burst');
        const ammo = p.slots[p.cur].ammo;
        const midReload = d.kind === 'gun' && (p.reloading || p.reloadAgain || this.reloadSlot === p.cur) && ammo < this.enoughAmmo(d) && dist >= RELOAD_INTERRUPT
          // Part-empty, in view: under direct attack it fires back, which ends the reload, and a sneaked
          // shell-by-shell reload never delays a ready shot.
          && !(ammo > 0 && !this.sightBlocked && (this.attacked || (this.sneak && d.maxReload < d.maxClip)));
        const holdFire = (this.sightBlocked && !this.shootBlind && !this.breaking) || this.panWait    // don't waste shots on a tree or a pan
          || (this.shield && !this.shieldPeek);                                                    // shielding: it only fires when it peeks
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
        // Like a player's reload, this can't start until the gun's fire or switch delay is over.
        if (d.kind === 'gun' && p.slots[p.cur].cooldown <= 0 && ((ammo === 0 && !twoGuns) || (this.reloadSlot === p.cur && ammo < this.enoughAmmo(d) && !(this.attacked && ammo > 0)))) p.requestReload();
      }
    }
  }

  SV.Bot = Bot;
})();
