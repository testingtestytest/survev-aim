// SURVEV modes: real survev weapons, centered player, quickswitch range and 1v1 bot.
(function () {
  const C = SV.CONFIG;
  const { rand } = SV.util;
  const STEP = 1 / 120;                         // fixed sim step
  const STACK_WINDOW = 0.35;                    // s between hits that still add to the same damage number
  const SCREEN_MARGIN = 4;                      // units a dynamic-range bot stays inside the screen edge
  const SPAWN_PAD = 70, SPAWN_PAD_BOTTOM = 150; // px a respawn stays clear of the screen edge and bottom HUD
  const SPAWN_MIN_DIST = 6;                     // units: never respawns right on top of you
  const SKIN = '#f8c574';
  const BOT_GUNS = ['m4a1', 'ak47', 'an94', 'famas', 'mp5', 'vector', 'ump9', 'm93r', 'm870', 'spas12', 'usas', 'mosin', 'sv98', 'm249'];
  // Scope zoom radii from gameConfig. Phones and tablets see further, as in player.ts m_getZoom.
  const RADII = AT.touch ? C.scopeZoomRadiusMobile : C.scopeZoomRadius;
  const SCOPES = Object.keys(RADII);             // 1x 2x 4x 8x 15x
  const viewPpu = (w, h, zoom) => (Math.max(Math.min(w, h) * (16 / 9), Math.max(w, h)) * 0.5) / zoom;
  const isDynamic = (cfg) => cfg.botRange === 'dynamic';
  const startDist = (cfg) => (isDynamic(cfg) ? SV.DYNAMIC_SPAWN : cfg.botRange);
  // Fixed distance: one ring. Dynamic: the closest and furthest it can choose.
  function rangeRings(g, w, h, ppu, cfg, alpha) {
    g.strokeStyle = `rgba(255,255,255,${alpha})`; g.setLineDash([4, 4]); g.lineWidth = 1;
    (isDynamic(cfg) ? SV.DYNAMIC_RANGE : [cfg.botRange]).forEach((d) => {
      g.beginPath(); g.arc(w / 2, h / 2, d * ppu, 0, Math.PI * 2); g.stroke();
    });
    g.setLineDash([]);
  }

  // ---------- previews ----------
  function miniPlayer(g, x, y, r, color) {
    g.fillStyle = color || SKIN; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
  }
  function miniGround(g, w, h, ppu, cx, cy) {
    g.fillStyle = '#80af49'; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,0,0,0.15)'; g.lineWidth = 1; g.beginPath();
    const step = 16 * ppu;
    for (let x = ((cx % step) + step) % step; x < w; x += step) { g.moveTo(x, 0); g.lineTo(x, h); }
    for (let y = ((cy % step) + step) % step; y < h; y += step) { g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
  }
  const label = (g, s, x, y, o) => AT.pv.text(g, s, x, y, { size: 11, color: '#fff', ...o });

  // How the chosen distance looks on a 16:9 screen with the chosen scope (real scale).
  function pvView(p) {
    const { g, w, h, cfg } = p;
    const zoom = RADII[cfg.scope];
    const ppu = viewPpu(w, h, zoom);
    miniGround(g, w, h, ppu, w / 2, h / 2);
    const s = p.s; s.t = (s.t || 0) + p.dt;
    const ang = Math.sin(s.t * 0.8) * 0.5;
    // dynamic: glide to a new random distance now and then, the way the real bot does
    if (isDynamic(cfg) && (s.goal == null || (s.goalT -= p.dt) <= 0)) {
      s.goal = rand(SV.DYNAMIC_RANGE[0], SV.DYNAMIC_RANGE[1]);
      s.goalT = rand(0.8, 2.2);
    }
    const goal = isDynamic(cfg) ? s.goal : cfg.botRange;
    s.d = s.d == null ? goal : s.d + (goal - s.d) * Math.min(1, p.dt * 4);
    const bx = w / 2 + Math.cos(ang) * s.d * ppu, by = h / 2 + Math.sin(ang) * s.d * ppu;
    rangeRings(g, w, h, ppu, cfg, 0.7);
    miniPlayer(g, w / 2, h / 2, ppu);
    miniPlayer(g, bx, by, ppu, '#e8a27c');
    label(g, `${isDynamic(cfg) ? 'DYNAMIC' : cfg.botRange + ' UNITS'} · ${cfg.scope.replace('scope', '').toUpperCase()} SCOPE`, 8, 8);
  }

  // Runs the real bot AI in a tiny world to show movement / distance / rushing.
  function pvBot(p) {
    const { g, w, h, cfg } = p, s = p.s;
    if (!s.world) {
      s.world = new SV.World();
      s.me = s.world.addPlayer(0, 0, {});
      s.bot = s.world.addPlayer(startDist(cfg), 0, {});
      s.ai = new SV.Bot(s.bot, s.me, botOpts(cfg, false));
      s.trail = []; s.t = 0;
    }
    for (let k = 0; k < 2; k++) { s.ai.update(p.dt / 2); s.world.update(p.dt / 2); }
    s.t += p.dt;
    s.trail.push({ x: s.bot.pos.x, y: s.bot.pos.y, t: s.t });
    while (s.trail.length && s.t - s.trail[0].t > 2.5) s.trail.shift();
    const zoom = isDynamic(cfg) ? SV.DYNAMIC_RANGE[1] * 1.1 : Math.max(cfg.botRange * 1.35, 10);
    const ppu = (Math.min(w, h) * 0.5) / zoom;
    miniGround(g, w, h, ppu, w / 2, h / 2);
    const X = (x) => w / 2 + x * ppu, Y = (y) => h / 2 + y * ppu;
    rangeRings(g, w, h, ppu, cfg, 0.5);
    g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath();
    s.trail.forEach((q, i) => (i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y))));
    g.stroke();
    miniPlayer(g, X(0), Y(0), Math.max(3, ppu));
    miniPlayer(g, X(s.bot.pos.x), Y(s.bot.pos.y), Math.max(3, ppu), '#e8a27c');
    let status = 'HOLDING DISTANCE';
    if (s.ai.mode === 'rush') status = 'RUSHING IN';
    else if (s.ai.mode === 'brawl') status = 'BRAWLING';
    else if (isDynamic(cfg)) {
      const dist = Math.hypot(s.bot.pos.x, s.bot.pos.y), [lo, hi] = s.ai.range();
      status = dist < lo ? 'BACKING AWAY' : dist > hi ? 'MOVING IN' : `HOLDING ~${Math.round(s.ai.goal)} UNITS`;
    }
    label(g, status, 8, 8);
  }

  // Point-blank damage per shot, and body shots to kill, using survev's armor formula.
  // Bot skill: the real AI moving at that skill, plus what the level means.
  function pvSkill(p) {
    pvBot(p);
    const S = SV.BOT_SKILL[p.cfg.skill];
    label(p.g, `TURNS EVERY ${S.run[0]}-${S.run[1]}S`, 8, p.h - 56, { size: 13 });
    label(p.g, `AIM ERROR ±${S.shotErr}°`, 8, p.h - 38, { size: 13 });
    label(p.g, p.cfg.dodge === 'on' ? `TRIES TO DODGE ${Math.round(S.dodge * 100)}% OF SHOTS` : 'DODGING OFF', 8, p.h - 20, { size: 13 });
    if (p.cfg.botGun2) label(p.g, `QUICKSWITCHES ${Math.round(S.qs * 100)}% OF SHOTS`, 8, p.h - 74, { size: 13 });
  }
  // Roughly which of your guns it can react to at this distance: flight time vs reaction + time to
  // get clear. Reversing direction clears fast, so ~30ms fits the measured dodge rates.
  function pvReact(p) {
    const { g, cfg } = p;
    const escape = 30;
    AT.pv.text(g, `SEES A SHOT AFTER ${p.v}MS`, 10, 9, { size: 15, color: '#ff6a00' });
    const at = startDist(cfg);
    AT.pv.text(g, isDynamic(cfg) ? `AT MID RANGE (${at} UNITS):` : `AT ${at} UNITS:`, 10, 32, { size: 13 });
    let y = 54;
    [cfg.primary, cfg.secondary].map((id) => SV.GUNS[id]).filter(Boolean).forEach((d) => {
      const flight = (at / d.bullet.speed) * 1000;
      const can = flight > p.v + escape;
      AT.pv.text(g, d.name.toUpperCase(), 10, y, { size: 14 });
      AT.pv.text(g, `${Math.round(flight)}MS · ${can ? 'CAN DODGE' : 'TOO FAST'}`, 10, y + 18, { size: 13, weight: 700, color: can ? '#000' : '#ff6a00' });
      y += 44;
    });
  }
  const skillSettings = (dodgeDefault) => [
    { key: 'skill', label: 'BOT SKILL', default: 'pro', preview: pvSkill,
      options: [{ v: 'low', label: 'LOW' }, { v: 'medium', label: 'MEDIUM' }, { v: 'high', label: 'HIGH' }, { v: 'pro', label: 'PRO' }] },
    { key: 'dodge', label: 'BOT DODGES BULLETS', default: dodgeDefault, preview: pvSkill,
      options: [{ v: 'off', label: 'OFF' }, { v: 'on', label: 'ON' }] },
    { key: 'dodgeReact', label: 'DODGE REACTION TIME', default: 150, when: (c) => c.dodge === 'on', preview: pvReact,
      options: [50, 100, 150, 200, 300].map((v) => ({ v, label: v + 'MS' })) },
  ];

  // Adrenaline: the game's bar, plus what this level does right now.
  function pvBoost(p) {
    const { g, w, v, cfg } = p;
    const bp = C.player.boostBreakpoints, total = bp.reduce((a, b) => a + b, 0);
    const colors = ['#ff901a', '#ff751a', '#ff6616', '#ff5600'];
    const gap = 3, bh = 16, usable = w - 24 - gap * 3;
    let x = 12, left = v / 100;
    bp.forEach((b, i) => {
      const frac = b / total, bw = usable * frac;
      g.fillStyle = '#000'; g.fillRect(x, 12, bw, bh);
      g.fillStyle = colors[i]; g.fillRect(x, 12, bw * Math.max(0, Math.min(1, left / frac)), bh);
      left = Math.max(left - frac, 0);
      x += bw + gap;
    });
    const fast = v >= SV.BOOST_SPEED_AT;
    const lines = !v ? ['NO ADRENALINE', 'NO HEALING, NO SPEED BONUS'] : [
      `HEALS ${SV.boostHeal(v)} HP/S`,
      fast ? `+${C.player.boostMoveSpeed} SPEED` : 'NO SPEED BONUS (NEEDS 50+)',
      cfg.boostDrain === 'off' ? 'STAYS AT THIS LEVEL' : `DRAINS ${C.player.boostDecay}/S${fast ? ` · BONUS LASTS ${Math.round((v - SV.BOOST_SPEED_AT) / C.player.boostDecay)}S` : ''}`,
    ];
    lines.forEach((l, i) => AT.pv.text(g, l, 12, 42 + i * 24, { size: i ? 13 : 15, color: i ? '#000' : '#ff6a00' }));
  }
  const boostOptions = [[0, 'NONE'], [20, 'LVL 1'], [40, 'LVL 2'], [75, 'LVL 3'], [100, 'LVL 4']].map(([v, label2]) => ({ v, label: label2 }));
  const adrenaline = () => [
    { key: 'myBoost', label: 'YOUR ADRENALINE', default: 0, preview: pvBoost, options: boostOptions },
    { key: 'botBoost', label: 'BOT ADRENALINE', default: 0, preview: pvBoost, options: boostOptions },
    { key: 'boostDrain', label: 'ADRENALINE DRAINS', default: 'on',
      preview: pvText((p) => (p.v === 'on' ? ['LIKE THE REAL GAME', `LOSES ${C.player.boostDecay} PER SECOND`] : ['TRAINING AID', 'STAYS AT THE CHOSEN LEVEL'])),
      options: [{ v: 'on', label: 'ON' }, { v: 'off', label: 'OFF' }] },
  ];

  // Shows the armored player with the game's sprites, what this piece blocks, and the result.
  function pvArmor(who, piece) {
    return (p) => {
      const { g, cfg, h } = p;
      const isBot = who === 'bot';
      const helmet = isBot ? cfg.botHelmet : cfg.myHelmet;
      const chest = isBot ? cfg.botVest : cfg.myVest;

      // left: the player wearing the current gear
      const panel = 98;
      g.fillStyle = '#80af49'; g.fillRect(0, 0, panel, h);
      SV.drawPlayer(g, { activeDef: SV.MELEE.fists, dir: { x: 1, y: 0 }, chest, helmet, recoilVis: 0, meleeAnim: 0 }, 42, h / 2 - 10, 2);
      AT.pv.text(g, isBot ? 'BOT' : 'YOU', panel / 2, h - 12, { size: 15, color: '#fff', align: 'center', base: 'middle' });

      // right: what this piece blocks, then damage per shot / shots to kill / headshot damage
      const x = panel + 8;
      const pct = (v) => Math.round(v * 100);
      const name = piece === 'helmet' ? 'HELMET' : 'VEST';
      const blocks = !p.v ? `NO ${name}`
        : piece === 'helmet' ? `-${pct(C.armor.helmet[p.v] * 0.3)}% BODY · -${pct(C.armor.helmet[p.v])}% HEAD`
          : `-${pct(C.armor.chest[p.v])}% BODY · 0% HEAD`;
      AT.pv.text(g, blocks, x, 9, { size: 15, color: '#ff6a00' });

      const ids = isBot ? [cfg.primary, cfg.secondary, cfg.melee] : [cfg.botGun];
      let y = 34;
      ids.map((id) => SV.defOf(id)).filter(Boolean).forEach((d) => {
        const isGun = d.kind === 'gun';
        const base = isGun ? d.bullet.damage : d.damage;
        const n = isGun ? d.bulletCount : 1;
        const body = SV.applyArmor(base, false, chest, helmet) * n;
        const head = isGun ? SV.applyArmor(base * d.headshotMult, true, chest, helmet) * n : null;
        AT.pv.text(g, (isBot ? '' : 'BOT: ') + d.name.toUpperCase(), x, y, { size: 14 });
        const kills = Math.ceil(C.player.health / body);
        AT.pv.text(g, `${body.toFixed(0)} · ${kills} TO KILL${head != null ? ` · HEAD ${head.toFixed(0)}` : ''}`, x, y + 18, { size: 13, weight: 700 });
        y += 48;
      });
    };
  }
  const armorOptions = [0, 1, 2, 3].map((v) => ({ v, label: v ? 'LVL ' + v : 'NONE' }));
  const armorSetting = (key, label2, who, piece) => ({ key, label: label2, default: 0, pvTall: true, preview: pvArmor(who, piece), options: armorOptions });
  const botArmor = () => [armorSetting('botHelmet', 'BOT HELMET', 'bot', 'helmet'), armorSetting('botVest', 'BOT VEST', 'bot', 'vest')];
  const myArmor = () => [armorSetting('myHelmet', 'YOUR HELMET', 'me', 'helmet'), armorSetting('myVest', 'YOUR VEST', 'me', 'vest')];

  // Top-down look at a 1x screen's worth of the real placement rules.
  const OBSTACLE_AMOUNT = { few: 0.5, normal: 1, many: 2 };
  function pvObstacles(p) {
    const { g, w, h, v, s } = p;
    if (!OBSTACLE_AMOUNT[v]) { pvText(['NO OBSTACLES', 'OPEN GRASS.'])(p); return; }
    if (s.shown !== v) {
      const field = new SV.ObstacleField(OBSTACLE_AMOUNT[v]);
      s.items = field.near(0, 0, 40);
      s.shown = v;
    }
    const ppu = w / 56, cx = w / 2, cy = h / 2;
    g.fillStyle = '#80af49';
    g.fillRect(0, 0, w, h);
    for (const o of s.items) {
      g.fillStyle = o.kind === 'tree' ? '#3e502e' : '#b3b3b3';
      g.beginPath();
      g.arc(cx + o.x * ppu, cy + o.y * ppu, (o.kind === 'tree' ? o.r * 2 : o.r) * ppu, 0, Math.PI * 2);
      g.fill();
    }
    miniPlayer(g, cx, cy, ppu, '#f8c574');
    AT.pv.text(g, v === 'normal' ? "THE GAME'S DENSITY" : v === 'few' ? 'HALF THE DENSITY' : 'DOUBLE THE DENSITY', 8, 8, { size: 13, color: '#fff' });
  }

  function pvText(lines) {
    return (p) => {
      const ls = typeof lines === 'function' ? lines(p) : lines;
      ls.forEach((l, i) => AT.pv.text(p.g, l, 12, 14 + i * 22, { size: i ? 13 : 15, color: i ? '#000' : '#ff6a00' }));
    };
  }

  // ---------- settings ----------
  // The same settings with some defaults changed, for a mode that starts differently.
  const startingAt = (settings, defaults) => settings.map((s) => (s.key in defaults ? { ...s, default: defaults[s.key] } : s));
  const loadout = () => [
    { key: 'primary', label: 'PRIMARY', type: 'weapon', pick: 'gun', default: 'mosin', allowNone: true },
    { key: 'secondary', label: 'SECONDARY', type: 'weapon', pick: 'gun', default: 'spas12', allowNone: true },
    { key: 'melee', label: 'MELEE', type: 'weapon', pick: 'melee', default: 'pan' },
  ];
  const botRange = { key: 'botRange', label: 'BOT DISTANCE', default: 'dynamic', preview: pvView,
    options: [{ v: 'dynamic', label: 'DYNAMIC' }, { v: 8, label: 'CLOSE' }, { v: 16, label: 'MID' }, { v: 24, label: 'FAR' }, { v: 34, label: 'LONG' }] };
  const obstaclesSetting = { key: 'obstacles', label: 'ROCKS AND TREES', default: 'off', preview: pvObstacles,
    options: [{ v: 'off', label: 'OFF' }, { v: 'few', label: 'FEW' }, { v: 'normal', label: 'NORMAL' }, { v: 'many', label: 'MANY' }] };
  const scope = { key: 'scope', label: 'SCOPE', default: '1xscope', preview: pvView,
    options: SCOPES.map((v) => ({ v, label: v.replace('scope', '').toUpperCase() + ` (${RADII[v]})` })) };
  const NADE_COUNT = 3;
  const BOT_GAP = 6;                             // units apart bots spawn
  const botsSetting = (who) => ({ key: 'bots', label: 'BOTS', default: 1,
    preview: pvText((p) => (p.v === 1 ? ['ONE BOT'] : [`${p.v} BOTS AT ONCE`, who, "THEY CAN'T HURT EACH OTHER.", 'EACH COMES BACK ON ITS OWN.'])),
    options: [1, 2, 3, 4, 5].map((v) => ({ v, label: String(v) })) });
  const RESPAWN_SAFE = 1;                        // s you can't be hurt after losing a life
  const nadeOptions = [{ v: 'on', label: 'ON' }, { v: 'off', label: 'OFF' }];
  const nadeText = (who) => pvText((p) => (p.v === 'on' ? [`${who} ${NADE_COUNT} FRAG GRENADES`, 'THEY RECHARGE AFTER A KILL.', 'HOLD TO COOK, 4S FUSE.'] : ['NO GRENADES'])) ;
  const myNadesSetting = { key: 'myNades', label: 'YOUR GRENADES', default: 'on', preview: nadeText('YOU GET'), options: nadeOptions };
  const botNadesSetting = { key: 'botNades', label: 'BOT GRENADES', default: 'on', preview: nadeText('IT GETS'), options: nadeOptions };
  const infAmmo = { key: 'infAmmo', label: 'INFINITE BULLETS', default: 'off',
    preview: pvText((p) => (p.v === 'off' ? ['OFF', 'MAGS RUN OUT AND RELOAD', 'LIKE THE REAL GAME.'] : ['TRAINING AID', 'GUNS NEVER NEED A RELOAD', p.v === 'both' ? 'FOR YOU AND THE BOT.' : 'FOR YOU ONLY.'])),
    options: [{ v: 'off', label: 'OFF' }, { v: 'you', label: 'YOU' }, { v: 'both', label: 'YOU AND BOT' }] };
  const popups = { key: 'popups', label: 'DAMAGE NUMBERS', default: 'on',
    preview: pvText(['TRAINING AID', 'NOT IN THE REAL GAME.', 'SHOWS DAMAGE PER HIT,', 'YELLOW = HEADSHOT.']),
    options: [{ v: 'off', label: 'OFF' }, { v: 'on', label: 'ON' }] };

  function botOpts(cfg, fire, view) {
    return {
      distance: cfg.botRange, view, rush: cfg.rush || 'never',
      movement: cfg.botMove === 'still' ? 'strafe' : cfg.botMove || 'strafe', still: cfg.botMove === 'still',
      fire, skill: cfg.skill, items: cfg.botItems === 'on',
      dodge: cfg.dodge === 'on', dodgeReact: (cfg.dodgeReact || 150) / 1000,
    };
  }

  // ---------- game ----------
  function createGame(cfg, api, kind) {
    const world = new SV.World();
    if (OBSTACLE_AMOUNT[cfg.obstacles]) world.field = new SV.ObstacleField(OBSTACLE_AMOUNT[cfg.obstacles]);
    // The setting is the scope a round starts on. It can be changed during the round, and the view eases over.
    let scope = cfg.scope, zoom = RADII[scope], shownZoom = zoom, wheelDir = 0;
    function setScope(next) {
      scope = next;
      zoom = RADII[next];
      if (world.time === 0) shownZoom = zoom;  // still counting down: nothing to ease from
    }
    const stepScope = (dir) => { const next = SCOPES[SCOPES.indexOf(scope) + dir]; if (next) setScope(next); };   // player.ts: stops at the ends
    const timeline = [];
    const popupsArr = [];
    const st = { shots: 0, hits: 0, heads: 0, dmg: 0, kills: 0, ttk: [], switches: 0, free: 0, deaths: 0, taken: 0, reflects: 0,
      lastShot: [null, null, null], gaps: [], byWeapon: {} };
    const keyLabels = () => [AT.bindLabel('primary'), AT.bindLabel('secondary'), AT.bindLabel('melee'), AT.bindLabel('grenade')];
    const myNades = cfg.myNades === 'on' ? NADE_COUNT : 0, botNades = kind === '1v1' && cfg.botNades === 'on' ? NADE_COUNT : 0;
    const botCount = Math.max(1, cfg.bots || 1);
    const bots = [];                         // { p, ai, born, respawnT } for each bot, which come back on their own
    let lastShotT = null, lastHitShot = null;

    const meEvents = {
      shot(p, d) {
        st.shots++;
        const w = (st.byWeapon[d.name] = st.byWeapon[d.name] || { shots: 0, hits: 0, dmg: 0 });
        w.shots++;
        if (lastShotT != null) st.gaps.push(world.time - lastShotT);
        lastShotT = world.time;
        timeline.push({ t: world.time, type: 'shot', slot: p.cur });
      },
      melee(p, d) { timeline.push({ t: world.time, type: 'shot', slot: 2 }); },
      switch(p, e) {
        st.switches++;
        if (e.free) st.free++;
        timeline.push({ t: world.time, type: 'switch', free: e.free, delay: e.delay });
      },
      hit(p, target, res, d, shotId) {
        if (target === p) { st.taken += res.dealt; return; }   // your own bullet, reflected back at you
        // pellets of one shotgun blast count as one hit / one damage number
        const sameShot = shotId != null && shotId === lastHitShot;
        lastHitShot = shotId;
        st.dmg += res.dealt;
        if (res.head) st.heads++;
        // A grenade isn't a shot you aimed, so it doesn't count toward accuracy.
        const aimed = d.kind === 'gun' || d.kind === 'melee';
        if (aimed) (st.byWeapon[d.name] = st.byWeapon[d.name] || { shots: 0, hits: 0, dmg: 0 }).dmg += res.dealt;
        const w = st.byWeapon[d.name];
        if (!sameShot && aimed) {
          st.hits++; w.hits++;
          for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].type === 'shot' && !timeline[i].hit) { timeline[i].hit = true; break; }
        }
        if (cfg.popups === 'on') {
          // Rapid-fire guns keep one running total while hits land less than STACK_WINDOW apart.
          const rapid = d.kind === 'gun' && (d.fireMode !== 'single' || d.fireDelay <= 0.2);
          const q = popupsArr.find((x) => (sameShot && x.shotId === shotId)
            || (rapid && x.gun === d.name && x.target === target && x.t < STACK_WINDOW));
          if (q) {
            q.dmg += res.dmg; q.text = q.dmg.toFixed(0); q.head = q.head || res.head;
            q.shotId = shotId;
            if (!sameShot) { q.t = 0; q.x = target.pos.x; q.y = target.pos.y - 1.2; }
          } else {
            popupsArr.push({ x: target.pos.x, y: target.pos.y - 1.2, dmg: res.dmg, text: res.dmg.toFixed(0),
              head: res.head, t: 0, shotId, gun: d.name, target });
          }
        }
        if (res.killed) botKilled(target);
      },
      reflect() { st.reflects++; },
    };
    function botKilled(p) {
      const b = bots.find((q) => q.p === p);
      if (!b) return;
      st.kills++; st.ttk.push(world.time - b.born); b.respawnT = 0.6;
      // training reward: full health and full reload on kill
      me.health = C.player.health;
      if (myNades) me.setGrenades(myNades);    // a kill recharges your grenades
      me.slots.forEach((s) => { const sd = SV.defOf(s.type); if (sd && sd.kind === 'gun') s.ammo = sd.maxClip; });
      me.cancelAction(); me.scheduledReload = false;
    }
    const botEvents = {
      reflect() { st.botReflects = (st.botReflects || 0) + 1; },
      hit(p, target, res) {
        if (target !== p) { st.taken += res.dealt; return; }
        // The bot's own shot, sent back by your pan: that damage is yours.
        st.dmg += res.dealt;
        if (cfg.popups === 'on') popupsArr.push({ x: target.pos.x, y: target.pos.y - 1.2, dmg: res.dmg, text: res.dmg.toFixed(0), head: res.head, t: 0, target });
        if (res.killed) botKilled(p);
      },
    };

    const me = world.addPlayer(0, 0, { id: 'me', helmet: cfg.myHelmet || 0, chest: cfg.myVest || 0, boost: cfg.myBoost || 0, boostDrain: cfg.boostDrain !== 'off', events: meEvents, infiniteAmmo: cfg.infAmmo !== 'off' && !!cfg.infAmmo });
    world.audio = SV.Audio.begin(me, [cfg.primary, cfg.secondary, cfg.melee || 'fists', ...(kind === '1v1' ? [cfg.botGun, cfg.botGun2, cfg.botMelee] : ['fists'])]);
    SV.preload(C.armor.chestSkin.concat(C.armor.helmetSkin).filter(Boolean).flatMap((a) => [a.sprite, a.loot]));
    me.setLoadout(cfg.primary || '', cfg.secondary || '', cfg.melee || 'fists');
    me.setGrenades(myNades);
    const preload = [me.slots[0].type, me.slots[1].type, me.slots[2].type, cfg.botMelee, ...BOT_GUNS].map(SV.defOf).filter(Boolean);
    const F = SV.FRAG;
    SV.preload([...Object.values(SV.ITEMS).map((i) => i.loot), 'map-stone-01', 'part-log-01', 'part-heal-basic', 'part-boost-basic', F.loot, F.worldImg.sprite, ...Object.values(SV.EXPLOSIONS).flatMap((e) => [e.burst.image, e.decal.sprite]), ...Object.values(F.handImg).flatMap((h) => [h.left && h.left.sprite, h.right && h.right.sprite])]);
    SV.preload(['player-base-01', 'player-hands-01', 'player-bullet-trail-02', ...preload.flatMap((d) => [d.loot, d.world && d.world.sprite, d.world && d.world.magImg && d.world.magImg.sprite])]);

    // Anywhere you can currently see, so a bigger scope means a wider spread. Measured in pixels so it
    // clears the screen edge and bottom HUD at every zoom. A still bot at a chosen distance keeps that distance.
    function spawnOffset() {
      if (cfg.botMove === 'still' && !isDynamic(cfg)) {
        const a = rand(0, Math.PI * 2);
        return { x: Math.cos(a) * cfg.botRange, y: Math.sin(a) * cfg.botRange };
      }
      const { W, H } = api.size, ppu = viewPpu(W, H, zoom);
      const hw = (W / 2 - SPAWN_PAD) / ppu, top = (H / 2 - SPAWN_PAD) / ppu, bottom = (H / 2 - SPAWN_PAD_BOTTOM) / ppu;
      let at;
      for (let tries = 0; tries < 30; tries++) {
        at = { x: rand(-hw, hw), y: rand(-top, bottom) };
        if (Math.hypot(at.x, at.y) >= SPAWN_MIN_DIST && (!world.field || world.field.isFree(me.pos.x + at.x, me.pos.y + at.y, 2))
          && bots.every((b) => b.p.dead || Math.hypot(me.pos.x + at.x - b.p.pos.x, me.pos.y + at.y - b.p.pos.y) >= BOT_GAP)) break;
      }
      return at;
    }

    function spawnBot(k) {
      const old = bots[k];
      if (old) world.players = world.players.filter((p) => p !== old.p);
      const at = spawnOffset();
      const bot = world.addPlayer(me.pos.x + at.x, me.pos.y + at.y,
        { id: k ? 'bot' + (k + 1) : 'bot', team: 'bots', helmet: cfg.botHelmet || 0, chest: cfg.botVest || 0, boost: cfg.botBoost || 0, boostDrain: cfg.boostDrain !== 'off', events: botEvents, infiniteAmmo: cfg.infAmmo === 'both' });
      const fire = kind === '1v1';
      bot.setLoadout(fire ? cfg.botGun : '', fire ? cfg.botGun2 || '' : '', (fire && cfg.botMelee) || 'fists');
      bot.setGrenades(botNades);
      const ai = new SV.Bot(bot, me, botOpts(cfg, kind === '1v1', () => {
        const { W, H } = api.size, ppu = viewPpu(W, H, zoom);
        return { hw: W / 2 / ppu - SCREEN_MARGIN, hh: H / 2 / ppu - SCREEN_MARGIN };
      }));
      bots[k] = { p: bot, ai, born: world.time, respawnT: -1 };
    }
    for (let k = 0; k < botCount; k++) spawnBot(k);
    // The health bar at the top is for the nearest bot still standing.
    function shownBot() {
      let best = null, bestD = Infinity;
      for (const b of bots) {
        if (b.p.dead) continue;
        const d = Math.hypot(b.p.pos.x - me.pos.x, b.p.pos.y - me.pos.y);
        if (d < bestD) { bestD = d; best = b.p; }
      }
      return best || bots[0].p;
    }

    function readInput() {
      const k = api.keys;
      me.input.up = AT.bindHeld('up', k);
      me.input.down = AT.bindHeld('down', k);
      me.input.left = AT.bindHeld('left', k);
      me.input.right = AT.bindHeld('right', k);
      me.input.shootHold = api.mouse.down;
      const { W, H } = api.size;
      const dx = api.mouse.x - W / 2, dy = api.mouse.y - H / 2, l = Math.hypot(dx, dy);
      if (l > 0.5) me.dir = { x: dx / l, y: dy / l };
      me.toMouseLen = l / viewPpu(W, H, shownZoom);
    }

    // Touch input, in the order of survev's game.ts. shootStart stays set while firing, as it does there.
    const touch = AT.touch ? new SV.Touch({ moveStyle: cfg.touchMove, aimStyle: cfg.touchAim, aimLine: cfg.touchLine === 'on' }) : null;
    if (touch) SV.preload(['bullets']);
    function readTouch() {
      const { W, H } = api.size;
      const r = touch.update(STEP, W, H);
      me.input.moveDir = r.move;
      me.dir = r.aim;
      // game.ts: how far the aim stick is pushed. Lifting your thumb to throw leaves it where it was.
      if (r.aimLen > 0) me.toMouseLen = Math.min(1, r.aimLen) * C.player.throwableMaxMouseDist;
      me.input.shootHold = r.shoot;
      if (r.shoot) me.input.shootStart = true;
    }

    let acc = 0;
    return {
      ownHud: true,
      touch,
      // A finger came down during the round. True if it pressed a button rather than a stick.
      touchPress(x, y) {
        const { W, H } = api.size;
        if (this.uiClick(x, y)) return true;
        const b = SV.touchButton(W, H, x, y, me.activeDef.kind === 'gun', me.nades > 0);
        if (b === null) return false;
        if (b === 'reload') me.requestReload(); else me.switchTo(b);
        return true;
      },
      // A press on the scope row or an item is only that, and never a shot.
      uiClick(x, y) {
        const { W, H } = api.size;
        const hit = SV.scopeAt(W, H, !!touch, SCOPES, scope, x, y);
        if (hit) { if (hit !== scope) setScope(hit); return true; }
        const item = SV.itemAt(W, H, !!touch, x, y);
        if (!item) return false;
        // The one you're using cancels it, as a second way to do what the cancel key does.
        if (world.time > 0) { if (me.action && me.action.type === 'use' && me.action.item === item) me.cancelAction(); else me.useItem(item); }
        return true;
      },
      wheel(dir) { wheelDir = dir; },
      update(dt) {
        // game.ts: the wheel counts once per update however far it's spun, and the camera eases toward the scope
        if (wheelDir) { me.cycleWeapon(wheelDir); wheelDir = 0; }
        const want = 1 / zoom, now = 1 / shownZoom;
        shownZoom = 1 / (now + (want - now) * Math.min(1, dt * (want > now ? 2 : 1.4)));
        acc += dt;
        while (acc >= STEP) {
          acc -= STEP;
          if (touch) readTouch(); else readInput();
          for (const b of bots) b.ai.update(STEP);
          world.update(STEP);
          bots.forEach((b, k) => { if (b.respawnT >= 0 && (b.respawnT -= STEP) < 0) spawnBot(k); });
          if (me.dead) {
            st.deaths++;
            me.dead = false; me.health = C.player.health; me.boost = cfg.myBoost || 0;
            me.setGrenades(myNades);           // a new life, and a kill for the bot: both have their grenades again
            for (const b of bots) if (!b.p.dead) b.p.setGrenades(botNades);
            world.clearShots();
            me.safeT = RESPAWN_SAFE;
            api.loseLife();
          }
        }
        popupsArr.forEach((q) => (q.t += dt));
        for (let i = popupsArr.length - 1; i >= 0; i--) if (popupsArr[i].t > 0.8) popupsArr.splice(i, 1);
        while (timeline.length > 80) timeline.shift();
      },
      mousedown() { me.input.shootStart = true; },
      keydown(code) {
        const a = AT.actionOf(code);
        if (a === 'primary') me.switchTo(0);
        else if (a === 'secondary') me.switchTo(1);
        else if (a === 'melee') me.switchTo(2);
        else if (a === 'grenade') me.switchTo(3);
        else if (a === 'swap') me.swapKey();
        else if (a === 'reload') me.requestReload();
        else if (a === 'cancel') me.cancelAction();   // player.ts Input.Cancel: stops a reload or an item
        else if (SV.ITEMS[a]) me.useItem(a);
        else if (a === 'nextScope') stepScope(1);
        else if (a === 'prevScope') stepScope(-1);
        return !!a;
      },
      draw(g) {
        const { W, H } = api.size;
        SV.drawWorld(g, W, H, world, me.pos, shownZoom, { popups: cfg.popups === 'on' ? popupsArr : null });
        if (touch) touch.drawAimLine(g, W, H, me, shownZoom, viewPpu(W, H, shownZoom));
        const left = api.timeLeft != null ? `TIME ${Math.max(0, api.timeLeft).toFixed(1)}` : `LIVES ${api.lives}`;
        SV.drawHud(g, W, H, me, {
          keyLabels: keyLabels(), time: world.time, scopes: SCOPES, scope, mouse: api.mouse,
          topLeft: left,
          topRight: kind === '1v1' ? `KILLS ${st.kills}  DEATHS ${st.deaths}` : `DMG ${Math.round(st.dmg)}`,
          bot: shownBot(), timeline: kind === 'range' || cfg.timeline === 'on' ? timeline : null, touch: !!touch,
          boxes: [
            api.timeLeft != null ? { label: 'Time', value: Math.ceil(Math.max(0, api.timeLeft)) } : { label: 'Lives', value: api.lives },
            kind === '1v1' ? { label: 'Kills', value: st.kills, side: 'left' } : { label: 'Damage', value: Math.round(st.dmg), side: 'left' },
            ...(kind === '1v1' ? [{ label: 'Deaths', value: st.deaths, side: 'right' }] : []),
          ],
        });
        if (touch) { touch.resize(W, H); touch.drawPads(g); }
      },
      hud: () => [],
      results() {
        const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
        const rows = [
          ['DAMAGE', Math.round(st.dmg)],
          ...(kind === '1v1' ? [] : [['KILLS', st.kills]]),   // 1v1's headline number
          ['ACCURACY', AT.pct(st.hits, st.shots)],
          ['HEADSHOTS', st.heads],
          ['AVG TIME TO KILL', st.ttk.length ? avg(st.ttk).toFixed(2) + 'S' : '—'],
          ['SWITCHES', st.switches],
          ['FREE SWITCHES', AT.pct(st.free, st.switches)],
          ['AVG TIME BETWEEN SHOTS', st.gaps.length ? avg(st.gaps).toFixed(2) + 'S' : '—'],
        ];
        if (kind === '1v1' && cfg.botMelee === 'pan') rows.push(['BOT DEFLECTED', st.botReflects || 0]);
        if (kind === '1v1') rows.push(['DEATHS', st.deaths], ['DAMAGE TAKEN', Math.round(st.taken)]);
        if (me.slots[2].type === 'pan') rows.push(['SHOTS REFLECTED', st.reflects]);
        Object.entries(st.byWeapon).forEach(([n, w]) => rows.push([n.toUpperCase() + ' HITS', `${w.hits}/${w.shots}`]));
        if (kind === '1v1') return { score: st.kills, scoreLabel: st.kills === 1 ? 'KILL' : 'KILLS', rows };
        return { score: Math.round(st.dmg) + st.kills * 100 - st.deaths * 100, rows };
      },
    };
  }

  // survev's own touch options, defaults from client/src/config.ts. Hidden on desktop.
  const touchSettings = () => [
    { key: 'touchMove', label: 'MOVE STICK', default: 'anywhere', when: () => AT.touch,
      preview: pvText(['ANYWHERE: IT STARTS WHERE', 'YOUR THUMB LANDS.', 'FIXED: IT STAYS IN ONE SPOT.']),
      options: [{ v: 'anywhere', label: 'ANYWHERE' }, { v: 'locked', label: 'FIXED' }] },
    { key: 'touchAim', label: 'AIM STICK', default: 'anywhere', when: () => AT.touch,
      preview: pvText(['ANYWHERE: IT STARTS WHERE', 'YOUR THUMB LANDS.', 'FIXED: IT STAYS IN ONE SPOT.']),
      options: [{ v: 'anywhere', label: 'ANYWHERE' }, { v: 'locked', label: 'FIXED' }] },
    { key: 'touchLine', label: 'AIM LINE', default: 'on', when: () => AT.touch,
      preview: pvText(['DOTS SHOW WHERE YOU AIM', 'WHILE YOU HOLD THE AIM STICK.']),
      options: [{ v: 'off', label: 'OFF' }, { v: 'on', label: 'ON' }] },
  ];

  AT.register({
    id: 'sv-1v1',
    group: 'survev',
    name: '1V1',
    description: 'Fight a bot that strafes, changes its range, heals behind cover and fights back. How many kills can you get before you run out of lives?',
    simple: ['primary', 'secondary', 'melee', 'myNades', 'bots', 'botRange', 'skill', 'botGun', 'botGun2', 'botMelee', 'botNades', 'obstacles', 'scope', 'end', 'duration'],
    settings: [
      ...loadout(),
      myNadesSetting,
      botsSetting('ALL OF THEM FIGHTING YOU.'),
      botRange,
      { key: 'rush', label: 'RUSHES', default: 'sometimes', preview: pvBot,
        options: [{ v: 'never', label: 'NEVER' }, { v: 'sometimes', label: 'SOMETIMES' }, { v: 'often', label: 'OFTEN' }] },
      { key: 'botMove', label: 'BOT MOVEMENT', default: 'strafe', preview: pvBot,
        options: [{ v: 'strafe', label: 'STRAFE' }, { v: 'wide', label: 'WIDE' }, { v: 'mixed', label: 'MIXED' }] },
      ...skillSettings('on'),
      ...startingAt(botArmor(), { botHelmet: 2, botVest: 2 }),
      ...startingAt(myArmor(), { myHelmet: 2, myVest: 2 }),
      ...startingAt(adrenaline(), { myBoost: 40, botBoost: 40 }),
      { key: 'botGun', label: 'BOT WEAPON', type: 'weapon', pick: 'gun', default: 'mosin', only: BOT_GUNS },
      { key: 'botGun2', label: 'BOT SECOND WEAPON', type: 'weapon', pick: 'gun', default: 'ak47', allowNone: true, only: BOT_GUNS },
      { key: 'botMelee', label: 'BOT MELEE', type: 'weapon', pick: 'melee', default: 'pan' },
      botNadesSetting,
      { key: 'botItems', label: 'BOT USES ITEMS', default: 'on',
        preview: pvText((p) => (p.v === 'on' ? ['HEALS AND DRINKS', 'BEHIND COVER IF IT CAN,', 'AND STOPS IF IT GETS ATTACKED.'] : ['NO ITEMS', 'IT ONLY HAS ITS ADRENALINE.'])),
        options: [{ v: 'on', label: 'ON' }, { v: 'off', label: 'OFF' }] },
      { key: 'timeline', label: 'SHOT TIMELINE', default: 'off',
        preview: pvText([AT.touch ? 'TOP-LEFT STRIP' : 'BOTTOM-LEFT STRIP', 'SHOTS, HITS AND EVERY', 'SWITCH DELAY (GREEN = FREE).']),
        options: [{ v: 'off', label: 'OFF' }, { v: 'on', label: 'ON' }] },
      ...touchSettings(),
      { ...obstaclesSetting, default: 'normal' },
      { ...scope, default: '4xscope' },
      infAmmo,
      popups,
      { key: 'end', label: 'PLAY UNTIL', default: 'lives', preview: AT.pv.endCond,
        options: [{ v: 'lives', label: 'LIVES RUN OUT' }, { v: 'time', label: 'TIME RUNS OUT' }] },
      { key: 'lives', label: 'LIVES', default: 5, when: (c) => c.end === 'lives', preview: AT.pv.lives,
        options: [1, 3, 5, 10, 20].map((v) => ({ v, label: String(v) })) },
      { key: 'duration', label: 'DURATION', default: 120, when: (c) => c.end === 'time', preview: AT.pv.duration,
        options: [60, 120, 180].map((v) => ({ v, label: v + 'S' })) },
    ],
    create: (cfg, api) => createGame(cfg, api, '1v1'),
  });

  AT.register({
    id: 'sv-range',
    group: 'survev',
    name: 'QUICKSWITCH',
    description: 'A strafing bot keeps changing its range at random. Shoot, switch, shoot again — the timeline shows every switch delay and whether it was free.',
    simple: ['primary', 'secondary', 'melee', 'bots', 'botRange', 'skill', 'obstacles', 'scope', 'duration'],
    settings: [
      ...loadout(),
      botsSetting('MORE TARGETS TO SWITCH BETWEEN.'),
      botRange,
      { key: 'botMove', label: 'BOT MOVEMENT', default: 'strafe', preview: pvBot,
        options: [{ v: 'still', label: 'STILL' }, { v: 'strafe', label: 'STRAFE' }, { v: 'wide', label: 'WIDE' }, { v: 'mixed', label: 'MIXED' }] },
      ...skillSettings('off'),
      ...botArmor(),
      ...adrenaline(),
      ...touchSettings(),
      obstaclesSetting,
      scope,
      infAmmo,
      myNadesSetting,
      popups,
      { key: 'duration', label: 'DURATION', default: 60, preview: AT.pv.duration,
        options: [30, 60, 120].map((v) => ({ v, label: v + 'S' })) },
    ],
    create: (cfg, api) => createGame(cfg, api, 'range'),
  });
})();
