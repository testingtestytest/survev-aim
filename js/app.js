// App shell: canvas, loop, input, screens, settings previews, crosshair, HUD, results.
(function () {
  const { store, COLORS } = AT;
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------- canvas ----------
  const canvas = $('#game');
  const g = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    if (AT.touch) dpr = Math.min(dpr, 2);   // phones report up to 4x; drawing that many pixels only costs frame rate
    W = innerWidth; H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
  }
  addEventListener('resize', resize);
  resize();

  // ---------- state ----------
  const HUD_H = 56, PAD = 24;
  const mouse = { x: -100, y: -100, down: false };
  const fx = [];
  const previews = [];           // live setting-preview canvases
  let state = 'menu';            // menu | settings | crosshair | countdown | playing | results
  let mode = null, cfg = null, game = null;
  let elapsed = 0, countdown = 0, ended = false;

  const keys = new Set();          // held KeyboardEvent.codes (for survev movement)
  const openPickers = new Set();   // expanded weapon pickers on the settings screen
  let menuGroup = store.get('tab', 'standard') === 'survev' ? 'survev' : 'standard';
  let capturing = null;            // { action, idx } while rebinding a key

  const api = {
    get bounds() { return { x: PAD, y: HUD_H + PAD, w: W - PAD * 2, h: H - HUD_H - PAD * 2 }; },
    get size() { return { W, H }; },
    get timeLeft() { return timed() ? cfg.duration - elapsed : null; },
    keys,
    mouse,
    lives: Infinity,
    loseLife() {
      if (api.lives === Infinity) return;
      api.lives--;
      if (api.lives <= 0) ended = true;
    },
    hitFx(x, y, r) { fx.push({ type: 'hit', x, y, r, t: 0 }); },
    missFx(x, y) { fx.push({ type: 'miss', x, y, t: 0 }); },
    end() { ended = true; },
  };

  const timed = () => cfg.end !== 'lives';

  // ---------- config helpers ----------
  function loadCfg(settings, saved) {
    saved = saved || {};
    const c = {};
    settings.forEach((s) => {
      const v = saved[s.key];
      const ok = s.type === 'range'
        ? typeof v === 'number' && v >= s.min && v <= s.max
        : s.type === 'weapon'
          ? (v === '' && s.allowNone) || (s.pick === 'gun' ? !!SV.GUNS[v] && (!s.only || s.only.includes(v)) : !!SV.MELEE[v])
          : s.options.some((o) => o.v === v);
      c[s.key] = ok ? v : s.default;
    });
    return c;
  }
  const activeSettings = (settings, c) => settings.filter((s) => !s.when || s.when(c));
  const modeCfg = (m) => loadCfg(m.settings, store.get('cfg:' + m.id, {}));
  const bestKey = (m, c) => 'best:' + m.id + ':' + activeSettings(m.settings, c).map((s) => c[s.key]).join('|');

  // ---------- crosshair ----------
  const xh = loadCfg(AT.XH_SETTINGS, store.get('xh', {}));
  const savedStyle = (store.get('xh', {}) || {}).style;
  xh.style = AT.CROSSHAIRS.some((c) => c.id === savedStyle) ? savedStyle : AT.XH_STYLE_DEFAULT;

  function applyCursor() {
    const cur = AT.buildCursor(xh);
    canvas.style.cursor = cur.css;
    $('#xh-btn-img').src = AT.buildCursor({ ...xh, size: 0.75 }).url;
    return cur;
  }

  // ---------- generic settings rows ----------
  function renderRows(box, settings, values, onChange, withPreview) {
    box.innerHTML = '';
    if (withPreview) previews.length = 0;
    settings.forEach((s) => {
      const hasPv = withPreview && s.preview;
      const row = el('div', 'row' + (hasPv ? ' has-pv' : ''));
      const main = el('div', 'row-main');
      main.appendChild(el('div', 'label', s.label));
      if (s.type === 'range') {
        const wrap = el('div', 'range');
        const input = el('input');
        Object.assign(input, { type: 'range', min: s.min, max: s.max, step: s.step, value: values[s.key] });
        const out = el('span', 'range-val', s.format ? s.format(values[s.key]) : String(values[s.key]));
        input.oninput = () => {
          const v = Math.round(parseFloat(input.value) / s.step) * s.step;
          const fixed = parseFloat(v.toFixed(4));
          out.textContent = s.format ? s.format(fixed) : String(fixed);
          onChange(s.key, fixed, true);
        };
        wrap.append(input, out);
        main.appendChild(wrap);
        row.appendChild(main);
        box.appendChild(row);
        return;
      }
      if (s.type === 'weapon') {
        renderWeaponPicker(main, s, values, onChange);
        row.appendChild(main);
        box.appendChild(row);
        return;
      }
      const opts = el('div', 'opts');
      s.options.forEach((o) => {
        const b = el('button', 'opt' + (values[s.key] === o.v ? ' sel' : ''), o.swatch ? '' : o.label);
        if (o.swatch) { b.classList.add('swatch'); b.style.background = o.swatch; b.title = o.label; }
        b.onclick = () => onChange(s.key, o.v);
        opts.appendChild(b);
      });
      main.appendChild(opts);
      row.appendChild(main);
      if (hasPv) {
        const cv = el('canvas', 'pv' + (s.pvTall ? ' tall' : ''));
        row.appendChild(cv);
        previews.push({ s, cv, state: {} });
      }
      box.appendChild(row);
    });
  }

  // ---------- survev weapon picker ----------
  function weaponStats(d) {
    if (!d) return 'EMPTY SLOT';
    if (d.kind === 'melee') {
      return `DMG ${d.damage} · SWING ${d.attack.cooldownTime}S · REACH ${(d.attack.offset.x + d.attack.rad).toFixed(2)} · SWITCH ${d.switchDelay}S`;
    }
    const b = d.bullet;
    const dmg = d.bulletCount > 1 ? `${b.damage}×${d.bulletCount}` : `${b.damage}`;
    const shootSpd = Math.max(1, (12 + d.speed.attack) * 0.5);
    return `DMG ${dmg} · FIRE ${d.fireDelay}S · SWITCH ${d.switchDelay}S · CLIP ${d.maxClip} · RELOAD ${d.reloadTime}S · SPEED WHILE FIRING ${shootSpd.toFixed(1)}`;
  }
  function weaponIcon(d) {
    const t = el('span', 'wpn-icon');
    if (d && d.loot) { const im = new Image(); im.src = 'assets/survev/' + d.loot + '.svg'; im.alt = ''; t.appendChild(im); }
    else t.textContent = '—';
    return t;
  }
  function renderWeaponPicker(main, s, values, onChange) {
    const cur = values[s.key];
    const d = SV.defOf(cur);
    const open = openPickers.has(s.key);
    const card = el('button', 'wpn-card' + (open ? ' open' : ''));
    const info = el('span', 'wpn-info');
    info.append(el('span', 'wpn-name', d ? d.name.toUpperCase() : 'NONE'), el('span', 'wpn-stats', weaponStats(d)));
    card.append(weaponIcon(d), info, el('span', 'wpn-change', open ? 'CLOSE ▴' : 'CHANGE ▾'));
    card.onclick = () => { open ? openPickers.delete(s.key) : openPickers.add(s.key); onChange(s.key, cur); };
    main.appendChild(card);
    if (!open) return;
    const list = s.pick === 'gun'
      ? Object.values(SV.GUNS).filter((x) => !s.only || s.only.includes(x.id))
      : Object.values(SV.MELEE);
    const groups = {};
    list.forEach((x) => { const k = x.kind === 'gun' ? x.cls : 'MELEE'; (groups[k] = groups[k] || []).push(x); });
    const pick = el('div', 'wpn-pick');
    const tile = (id, dd) => {
      const b = el('button', 'wpn-tile' + (id === cur ? ' sel' : ''));
      b.title = dd ? weaponStats(dd) : 'Empty slot';
      b.append(weaponIcon(dd), el('span', 'wpn-tile-name', dd ? dd.name.toUpperCase() : 'NONE'));
      b.onclick = () => { openPickers.delete(s.key); onChange(s.key, id); };
      return b;
    };
    if (s.allowNone) {
      const grp = el('div', 'wpn-group');
      grp.append(el('div', 'wpn-group-label', 'EMPTY'), (() => { const r = el('div', 'wpn-tiles'); r.appendChild(tile('', null)); return r; })());
      pick.appendChild(grp);
    }
    Object.entries(groups).forEach(([k, arr]) => {
      const grp = el('div', 'wpn-group');
      const r = el('div', 'wpn-tiles');
      arr.forEach((x) => r.appendChild(tile(x.id, x)));
      grp.append(el('div', 'wpn-group-label', k), r);
      pick.appendChild(grp);
    });
    main.appendChild(pick);
  }

  function drawPreviews(dt) {
    previews.forEach((pv) => {
      const w = pv.cv.clientWidth, h = pv.cv.clientHeight;
      if (!w || !h) return;
      if (pv.cv.width !== Math.round(w * dpr) || pv.cv.height !== Math.round(h * dpr)) {
        pv.cv.width = Math.round(w * dpr); pv.cv.height = Math.round(h * dpr);
      }
      const pg = pv.cv.getContext('2d');
      pg.setTransform(dpr, 0, 0, dpr, 0, 0);
      pg.fillStyle = COLORS.bg; pg.fillRect(0, 0, w, h);
      pv.s.preview({ g: pg, w, h, v: cfg[pv.s.key], cfg, dt, s: pv.state });
    });
  }

  // ---------- screens ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('on', s.id === id));
    const inGame = state === 'countdown' || state === 'playing';
    document.body.classList.toggle('in-game', inGame);
    $('#hud').classList.toggle('on', inGame && !(game && game.ownHud));
    if (!inGame) $('#countdown').textContent = '';
  }

  function goMenu() {
    state = 'menu';
    game = null;
    previews.length = 0;
    renderMenu();
    show('menu');
  }

  function renderMenu() {
    document.querySelectorAll('.tab[data-g]').forEach((b) => b.classList.toggle('sel', b.dataset.g === menuGroup));
    const list = $('#mode-list');
    list.innerHTML = '';
    AT.modes.filter((m) => (m.group || 'standard') === menuGroup).forEach((m, i) => {
      const c = el('button', 'card');
      const best = store.get(bestKey(m, modeCfg(m)), null);
      c.append(
        el('span', 'idx', String(i + 1).padStart(2, '0')),
        el('span', 'name', m.name),
        el('span', 'desc', (AT.touch && m.touchDescription) || m.description),
        el('span', 'best', 'BEST ' + (best ?? '—')),
      );
      c.onclick = () => openSettings(m);
      list.appendChild(c);
    });
  }

  // ---------- keybinds screen ----------
  function openBinds() {
    state = 'binds';
    capturing = null;
    renderBinds();
    show('binds');
  }
  function renderBinds() {
    const prefs = $('#prefs-list');
    prefs.innerHTML = '';
    [['blood', 'BLOOD IMPACTS'], ['fps', 'FPS COUNTER']].forEach(([key, label]) => {
      const row = el('div', 'row');
      row.appendChild(el('div', 'label', label));
      const opts = el('div', 'opts');
      [['on', 'ON'], ['off', 'OFF']].forEach(([v, text]) => {
        const b = el('button', 'opt' + (AT.prefs[key] === v ? ' sel' : ''), text);
        b.onclick = () => { AT.setPref(key, v); renderBinds(); };
        opts.appendChild(b);
      });
      row.appendChild(opts);
      prefs.appendChild(row);
    });
    const box = $('#binds-list');
    box.innerHTML = '';
    AT.BIND_ACTIONS.forEach((a) => {
      const row = el('div', 'row bind-row');
      row.appendChild(el('div', 'label', a.label));
      const opts = el('div', 'opts');
      [0, 1].forEach((idx) => {
        const isCap = capturing && capturing.action === a.id && capturing.idx === idx;
        const b = el('button', 'opt bind' + (isCap ? ' sel' : ''), isCap ? 'PRESS A KEY…' : AT.keyLabel(AT.binds[a.id][idx]));
        b.onclick = () => { capturing = { action: a.id, idx }; renderBinds(); };
        opts.appendChild(b);
      });
      row.appendChild(opts);
      box.appendChild(row);
    });
  }

  // Frames per second, counted over half a second so the number can be read. Survev modes keep it under
  // the speed box; standard modes and phones have the bottom-left corner free.
  const fps = { last: 0, frames: 0, time: 0, value: 0 };
  function countFps(now) {
    fps.frames++;
    fps.time += Math.max(0, now - fps.last) / 1000;
    fps.last = now;
    if (fps.time >= 0.5) { fps.value = Math.round(fps.frames / fps.time); fps.frames = 0; fps.time = 0; }
  }
  function drawFps() {
    if (!AT.prefs || AT.prefs.fps === 'off' || !fps.value) return;
    const survev = mode && mode.group === 'survev', w = 74, h = 22, x = 12;
    const y = survev && !AT.touch ? 46 : H - h - 12;
    g.fillStyle = survev ? 'rgba(0,0,0,0.24)' : '#ffffff';
    g.fillRect(x, y, w, h);
    g.font = '700 14px monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = survev ? '#ffffff' : '#000000';
    g.fillText(fps.value + ' FPS', x + w / 2, y + h / 2 + 1);
  }

  function openSettings(m) {
    mode = m;
    cfg = modeCfg(m);
    state = 'settings';
    renderSettings();
    show('settings');
  }

  function renderSettings() {
    $('#set-title').textContent = mode.name;
    $('#set-desc').textContent = (AT.touch && mode.touchDescription) || mode.description;
    // SIMPLE shows the essentials; everything else keeps its value from FULL.
    const active = activeSettings(mode.settings, cfg);
    const viewBox = $('#set-view');
    viewBox.style.display = mode.simple ? 'flex' : 'none';
    const simpleRows = mode.simple ? active.filter((s) => mode.simple.includes(s.key)) : active;
    const view = store.get('setview', 'simple') === 'full' ? 'full' : 'simple';
    if (mode.simple) {
      viewBox.querySelectorAll('.tab').forEach((b) => b.classList.toggle('sel', b.dataset.view === view));
      $('#set-view-full').textContent = `FULL (${active.length - simpleRows.length} MORE)`;
    }
    renderRows($('#set-list'), mode.simple && view === 'simple' ? simpleRows : active, cfg, (k, v) => {
      cfg[k] = v;
      store.set('cfg:' + mode.id, cfg);
      renderSettings();
    }, true);
    const best = store.get(bestKey(mode, cfg), null);
    $('#set-best').textContent = 'BEST FOR THIS SETUP: ' + (best ?? '—');
  }

  function openCrosshair() {
    state = 'crosshair';
    previews.length = 0;
    renderCrosshair();
    show('crosshair');
  }

  function renderCrosshair() {
    renderRows($('#xh-list'), activeSettings(AT.XH_SETTINGS, xh), xh, (k, v, live) => {
      xh[k] = v;
      store.set('xh', xh);
      if (live) refreshCrosshairVisuals(); else renderCrosshair();
    }, false);
    refreshCrosshairVisuals();
  }

  // Tiles + preview + cursor, without rebuilding the option rows (keeps sliders draggable).
  function refreshCrosshairVisuals() {
    const grid = $('#xh-grid');
    grid.innerHTML = '';
    AT.CROSSHAIRS.forEach((c) => {
      const b = el('button', 'xh-tile' + (xh.style === c.id ? ' sel' : ''));
      b.title = c.name;
      const img = new Image();
      img.src = AT.buildCursor({ ...xh, style: c.id, size: 1 }).url;
      b.appendChild(img);
      b.onclick = () => { xh.style = c.id; store.set('xh', xh); refreshCrosshairVisuals(); };
      grid.appendChild(b);
    });
    const cur = applyCursor();
    $('#xh-preview-img').src = cur.url;
    $('#xh-preview').style.cursor = cur.css;
  }

  // ---------- round lifecycle ----------
  function start() {
    if (!mode) return;
    elapsed = 0;
    ended = false;
    fx.length = 0;
    previews.length = 0;
    keys.clear();
    api.lives = cfg.end === 'lives' ? cfg.lives : Infinity;
    game = mode.create(cfg, api);
    countdown = 3;
    state = 'countdown';
    show(null);
    $('#hud-mode').textContent = mode.name;
    updateHud();
  }

  // Short fade-to-white "round over" screen that swallows clicks, so a late click
  // in the game can't land on a results button.
  let overT = 0;
  function gameOver() {
    state = 'gameover';
    overT = 0.5;
    const o = $('#gameover');
    o.textContent = timed() ? 'TIME' : 'OUT OF LIVES';
    o.classList.add('on');
  }

  function finish() {
    $('#gameover').classList.remove('on');
    state = 'results';
    const r = game.results();
    const key = bestKey(mode, cfg);
    const prev = store.get(key, null);
    const isBest = r.score > 0 && (prev == null || r.score > prev);
    if (isBest) store.set(key, r.score);

    $('#res-mode').textContent = mode.name + ' — ' + (timed() ? cfg.duration + 'S' : cfg.lives + ' LIVES');
    $('#res-score').textContent = r.score;
    const tag = $('#res-best');
    tag.className = 'tag' + (isBest ? ' new' : '');
    tag.textContent = isBest ? 'NEW BEST' : 'BEST ' + (prev ?? '—');

    const rows = $('#res-rows');
    rows.innerHTML = '';
    const all = [...r.rows];
    if (!timed()) all.push(['SURVIVED', elapsed.toFixed(1) + 'S']);
    all.forEach(([k, v]) => {
      const c = el('div', 'cell');
      c.append(el('div', 'k', k), el('div', 'v', String(v)));
      rows.appendChild(c);
    });
    show('results');
  }

  // ---------- hud ----------
  function updateHud() {
    const stats = $('#hud-stats');
    stats.innerHTML = '';
    game.hud().forEach(([k, v]) => {
      const s = el('span', 'stat', k);
      s.appendChild(el('b', null, String(v)));
      stats.appendChild(s);
    });
    const right = $('#hud-right');
    right.innerHTML = '';
    if (timed()) {
      const s = el('span', 'stat', 'TIME');
      s.appendChild(el('b', null, Math.max(0, cfg.duration - elapsed).toFixed(1)));
      right.appendChild(s);
    } else {
      right.append('LIVES');
      const box = el('span', 'lives');
      for (let i = 0; i < cfg.lives; i++) box.appendChild(el('i', i < api.lives ? 'full' : ''));
      right.appendChild(box);
    }
  }

  // ---------- effects ----------
  function drawFx(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.t += dt;
      const p = f.t / (f.type === 'hit' ? 0.28 : 0.35);
      if (p >= 1) { fx.splice(i, 1); continue; }
      g.globalAlpha = 1 - p;
      if (f.type === 'hit') {
        AT.ring(g, f.x, f.y, f.r + 22 * p, COLORS.accent, Math.max(0.5, 4 * (1 - p)));
      } else {
        const s = 7;
        g.strokeStyle = COLORS.fg; g.lineWidth = 2;
        g.beginPath();
        g.moveTo(f.x - s, f.y - s); g.lineTo(f.x + s, f.y + s);
        g.moveTo(f.x + s, f.y - s); g.lineTo(f.x - s, f.y + s);
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    // now can be slightly before last on the first frame, and a negative step breaks anything timed
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;

    if (state === 'countdown') {
      countdown -= dt;
      if (countdown <= 0) { state = 'playing'; $('#countdown').textContent = ''; }
      else $('#countdown').textContent = Math.ceil(countdown);
    } else if (state === 'playing') {
      elapsed += dt;
      game.update(dt);
      if (timed() && elapsed >= cfg.duration) { elapsed = cfg.duration; ended = true; }
    } else if (state === 'gameover') {
      overT -= dt;
    }

    countFps(performance.now());
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, W, H);
    if (state === 'countdown' || state === 'playing' || state === 'gameover') {
      game.draw(g);
      drawFx(dt);
      drawFps();
      updateHud();
    } else if (state === 'settings') {
      drawPreviews(dt);
    }

    if (state === 'playing' && ended) gameOver();
    else if (state === 'gameover' && overT <= 0) finish();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- input ----------
  addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    mouse.down = true;
    mouse.x = e.clientX; mouse.y = e.clientY;
    if (state === 'playing') game.mousedown(e.clientX, e.clientY);
  });
  addEventListener('mouseup', (e) => { if (e.button === 0) mouse.down = false; });
  addEventListener('blur', () => { mouse.down = false; keys.clear(); });
  addEventListener('contextmenu', (e) => { if (state === 'playing' || state === 'countdown') e.preventDefault(); });
  addEventListener('keyup', (e) => keys.delete(e.code));

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (state === 'gameover') { e.preventDefault(); return; }

    // rebinding a key
    if (state === 'binds' && capturing) {
      e.preventDefault();
      if (e.code === 'Escape') { capturing = null; }
      else if (e.code === 'Backspace' || e.code === 'Delete') { AT.setBind(capturing.action, capturing.idx, ''); capturing = null; }
      else { AT.setBind(capturing.action, capturing.idx, e.code); capturing = null; }
      renderBinds();
      return;
    }

    const inGame = state === 'playing' || state === 'countdown';
    const survev = mode && mode.group === 'survev';
    if (inGame) keys.add(e.code);
    if (k === 'escape') {
      e.preventDefault();
      if (state !== 'menu') goMenu();
      return;
    }
    // survev modes: game binds first (R is reload there, not restart)
    if (survev && inGame) {
      if (AT.actionOf(e.code)) e.preventDefault();
      if (state === 'playing' && !e.repeat && game.keydown) game.keydown(e.code);
      return;
    }
    if (k === 'r' && mode && ['countdown', 'playing', 'results'].includes(state)) {
      e.preventDefault();
      start();
    } else if (k === 'enter' && (state === 'settings' || state === 'results')) {
      e.preventDefault();
      start();
    }
  });

  // ---------- touch (phones and tablets only) ----------
  if (AT.touch) {
    document.body.classList.add('touch');
    $('#btn-start').textContent = 'START';
    $('#btn-retry').textContent = 'RETRY';
    $('#btn-res-menu').textContent = 'MENU';
    $('#touch-exit').onclick = goMenu;

    const inRound = () => (state === 'playing' || state === 'countdown') && game;
    const sticks = () => (inRound() && game.touch) || null;
    const heldByButton = new Set();    // fingers that pressed a slot or reload, which never become a stick

    // preventDefault also stops the browser sending a fake mouse click, which would count as a second shot.
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const pad = sticks();
        if (pad) {
          if (state === 'playing' && game.touchPress(t.clientX, t.clientY)) heldByButton.add(t.identifier);
          else pad.start(t.identifier, t.clientX, t.clientY);
        } else {
          // Standard modes: a finger is the mouse, and every finger that lands is a click.
          mouse.x = t.clientX; mouse.y = t.clientY; mouse.down = true;
          if (state === 'playing') game.mousedown(t.clientX, t.clientY);
        }
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const pad = sticks();
      for (const t of e.changedTouches) {
        if (pad) pad.move(t.identifier, t.clientX, t.clientY);
        else { mouse.x = t.clientX; mouse.y = t.clientY; }
      }
    }, { passive: false });
    const lift = (e) => {
      e.preventDefault();
      const pad = sticks();
      for (const t of e.changedTouches) {
        heldByButton.delete(t.identifier);
        if (pad) pad.end(t.identifier);
      }
      if (!pad) {
        mouse.down = e.touches.length > 0;
        if (mouse.down) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; }
      }
    };
    canvas.addEventListener('touchend', lift, { passive: false });
    canvas.addEventListener('touchcancel', lift, { passive: false });
  }

  document.querySelectorAll('.tab[data-g]').forEach((b) => {
    b.onclick = () => { menuGroup = b.dataset.g; store.set('tab', menuGroup); renderMenu(); };
  });
  document.querySelectorAll('.tab[data-view]').forEach((b) => {
    b.onclick = () => { store.set('setview', b.dataset.view); renderSettings(); };
  });
  // Phones have no keys to bind, so that screen only holds settings there.
  if (AT.touch) { $('#binds-btn').textContent = 'SETTINGS'; $('#binds-title').textContent = 'SETTINGS'; }
  $('#binds-btn').onclick = openBinds;
  $('#binds-back').onclick = goMenu;
  $('#binds-reset').onclick = () => { AT.resetBinds(); capturing = null; renderBinds(); };
  $('#btn-back').onclick = goMenu;
  $('#xh-back').onclick = goMenu;
  $('#xh-btn').onclick = openCrosshair;
  $('#btn-start').onclick = start;
  $('#btn-retry').onclick = start;
  $('#btn-res-settings').onclick = () => openSettings(mode);
  $('#btn-res-menu').onclick = goMenu;

  applyCursor();
  goMenu();

  // index.html#play=<mode id> jumps straight into a mode (handy for testing / bookmarks)
  const m = /play=([\w-]+)/.exec(location.hash);
  const direct = m && AT.modes.find((x) => x.id === m[1]);
  if (direct) { openSettings(direct); start(); countdown = 0.001; }
  const ms = /set=([\w-]+)/.exec(location.hash);
  const setMode = ms && AT.modes.find((x) => x.id === ms[1]);
  if (setMode) { menuGroup = setMode.group || 'standard'; openPickers.add('primary'); openSettings(setMode); }
})();
