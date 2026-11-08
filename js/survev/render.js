// Survev-look renderer: grass + grid, player/hand/gun sprites placed like survev's client
// (client/src/objects/player.ts + animData.ts), bullet tracers, and a game-style HUD.
(function () {
  const C = SV.CONFIG;
  const GRASS = '#80af49';                 // shared/defs/maps/baseDefs.ts biome.colors.grass
  const GRID = 16;                         // GameConfig.map.gridSize
  const SKIN = 0xf8c574;                   // outfitBase baseTint / handTint
  const FONT = '"Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  const K = 4;                             // supersampling for tinted sprite bitmaps

  // Bones, as in client animData.ts: body-local px (16px = 1 unit). Each pose is { pivot, rot, pos }.
  const HAND_L = 0, HAND_R = 1, MELEE_R = 5;
  const IDENTITY = { pivot: { x: 0, y: 0 }, rot: 0, pos: { x: 0, y: 0 } };
  const EASE = {
    easeInSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
    easeOutSine: (x) => Math.sin((x * Math.PI) / 2),
    easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  };
  const lerp = (t, a, b) => a + (b - a) * t;
  const lerpV = (t, a, b) => ({ x: lerp(t, a.x, b.x), y: lerp(t, a.y, b.y) });
  const lerpPose = (t, a, b) => ({ pivot: lerpV(t, a.pivot, b.pivot), rot: lerp(t, a.rot, b.rot), pos: lerpV(t, a.pos, b.pos) });

  // client player.selectIdlePose
  function idlePoseOf(d) {
    let name = 'fists';
    if (d.kind === 'melee') name = d.anim.idlePose;
    else if (d.pistol) name = d.isDual ? 'dualPistol' : 'pistol';
    else if (d.isBullpup) name = 'bullpup';
    else name = d.isDual ? 'dualRifle' : 'rifle';
    return SV.ANIM.idle[name] || SV.ANIM.idle.fists;
  }

  // client player.updateAnim: blend idle pose with the playing attack / deploy animation
  function bonesOf(p, d) {
    const idle = idlePoseOf(d);
    const out = {};
    const a = p.visAnim;
    if (a) {
      const fr = SV.ANIM.anims[a.name].frames;
      let A = -1, B = 0;
      while (a.t >= fr[B].time && B < fr.length - 1) { A++; B++; }
      A = Math.max(A, 0);
      const span = fr[B].time - fr[A].time;
      const t = span > 0 ? Math.min((a.t - fr[A].time) / span, 1) : 1;
      const lt = fr[B].ease && EASE[fr[B].ease] ? EASE[fr[B].ease](t) : t;
      [HAND_L, HAND_R, MELEE_R].forEach((i) => {
        const src = a.mirror ? (i % 2 === 0 ? i + 1 : i - 1) : i;
        const pa = fr[A].bones[src], pb = fr[B].bones[src];
        if (pa && pb) {
          const pose = lerpPose(lt, pa, pb);
          if (a.mirror) { pose.pos.y *= -1; pose.pivot.y *= -1; pose.rot *= -1; }
          a.cache[i] = { pose, weight: A === B ? t : 1 };
        }
      });
    }
    [HAND_L, HAND_R, MELEE_R].forEach((i) => {
      const base = idle[i] || IDENTITY;
      const c = a && a.cache[i];
      out[i] = c ? lerpPose(c.weight, base, c.pose) : { pivot: { ...base.pivot }, rot: base.rot, pos: { ...base.pos } };
    });
    return out;
  }

  // ---------- images ----------
  const imgs = {};
  SV.img = (name) => {
    if (!imgs[name]) { const im = new Image(); im.src = 'assets/survev/' + name + '.svg'; imgs[name] = im; }
    return imgs[name];
  };
  const tintCache = {};
  // Tinted, supersampled bitmap of an SVG sprite (PIXI-style multiply tint).
  function tinted(name, tint) {
    const key = name + ':' + tint;
    if (tintCache[key]) return tintCache[key];
    const im = SV.img(name);
    if (!im.complete || !im.naturalWidth) return null;
    const w = im.naturalWidth, h = im.naturalHeight;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * K); c.height = Math.ceil(h * K);
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0, c.width, c.height);
    if (tint !== 0xffffff) {
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = '#' + tint.toString(16).padStart(6, '0');
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(im, 0, 0, c.width, c.height);
    }
    c.srcW = w; c.srcH = h;
    tintCache[key] = c;
    return c;
  }
  SV.preload = (names) => names.forEach((n) => n && SV.img(n));
  const hex = (n, a = 1) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

  // draw sprite with anchor (ax, ay) and scale (sx, sy) at current transform origin
  function sprite(g, name, tint, ax, ay, sx, sy) {
    const c = tinted(name, tint);
    if (!c) return;
    const w = c.srcW * sx, h = c.srcH * sy;
    g.drawImage(c, -w * ax, -h * ay, w, h);
  }

  function drawGun(g, d) {
    // client Gun.setType: container rotated 90deg at handOffset, barrel anchored (0.5, 1)
    const wi = d.world;
    const off = d.isDual ? [-5.95, 0] : [-4.25, -1.75];
    if (wi.gunOffset) { off[0] += wi.gunOffset.x; off[1] += wi.gunOffset.y; }
    g.save();
    g.translate(off[0], off[1]);
    g.rotate(Math.PI / 2);
    const mag = () => { if (wi.magImg) { g.save(); g.translate(wi.magImg.pos.x, wi.magImg.pos.y); sprite(g, wi.magImg.sprite, 0xffffff, 0.5, 0.5, 0.25, 0.25); g.restore(); } };
    if (wi.magImg && !wi.magImg.top) mag();
    sprite(g, wi.sprite, wi.tint, 0.5, 1, wi.scale.x * 0.5, wi.scale.y * 0.5);
    if (wi.magImg && wi.magImg.top) mag();
    g.restore();
  }

  // client updateSprite / updateVisuals: the melee sprite lives in the right hand's container
  function drawMelee(g, w, bone) {
    g.save();
    g.translate(-bone.pivot.x, -bone.pivot.y);
    g.rotate(w.rot + bone.rot);
    g.scale(w.scale.x, w.scale.y);
    g.translate(w.pos.x + bone.pos.x, w.pos.y + bone.pos.y);
    sprite(g, w.sprite, w.tint, 0.5, 0.5, 1, 1);
    g.restore();
  }

  function drawHand(g, pose, gunDef, meleeWorld, meleeBone) {
    g.save();
    g.translate(pose.pos.x, pose.pos.y);
    g.rotate(pose.rot);
    g.translate(pose.pivot.x, pose.pivot.y);
    if (gunDef && !gunDef.world.handsBelow) drawGun(g, gunDef);
    if (meleeWorld && !meleeWorld.renderOnHand) drawMelee(g, meleeWorld, meleeBone);
    sprite(g, 'player-hands-01', SKIN, 0.5, 0.5, 0.175, 0.175);
    if (meleeWorld && meleeWorld.renderOnHand) drawMelee(g, meleeWorld, meleeBone);
    if (gunDef && gunDef.world.handsBelow) drawGun(g, gunDef);
    g.restore();
  }

  function drawPlayer(g, p, sx, sy, S) {
    const d = p.activeDef;
    const bones = bonesOf(p, d);
    const L = bones[HAND_L], R = bones[HAND_R];
    if (d.kind === 'gun') {
      if (d.world.leftHandOffset) { L.pos.x += d.world.leftHandOffset.x; L.pos.y += d.world.leftHandOffset.y; }
      const rec = p.recoilVis * d.world.recoil * 1.125;
      L.pos.x -= rec; R.pos.x -= rec;
    }
    const meleeWorld = d.kind === 'melee' ? d.world : null;
    g.save();
    g.translate(sx, sy);
    g.rotate(Math.atan2(p.dir.y, p.dir.x));
    g.scale(S, S);
    // body (scale 0.25) then hands (+ guns) on top, like the client's bodyContainer order
    sprite(g, 'player-base-01', SKIN, 0.5, 0.5, 0.25, 0.25);
    const chest = C.armor.chestSkin[p.chest];
    if (chest) sprite(g, chest.sprite, chest.tint, 0.5, 0.5, 0.25, 0.25);
    const gun = d.kind === 'gun' ? d : null;
    const drawL = () => drawHand(g, L, gun && gun.isDual ? gun : null);
    const drawR = () => drawHand(g, R, gun, meleeWorld, bones[MELEE_R]);
    if (meleeWorld && meleeWorld.leftHandOntop) { drawR(); drawL(); } else { drawL(); drawR(); }
    const helmet = C.armor.helmetSkin[p.helmet];
    if (helmet) {                          // client: helmet sits 3.33px behind center, above the hands
      g.translate(-3.33, 0);
      sprite(g, helmet.sprite, helmet.tint, 0.5, 0.5, helmet.scale, helmet.scale);
    }
    g.restore();
  }

  SV.drawPlayer = drawPlayer;

  // ---------- world ----------
  SV.drawWorld = (g, W, H, world, cam, zoomRadius, extras = {}) => {
    // client game.ts: targetZoom = max(minDim * 16/9, maxDim) * 0.5 / (zoom * ppu)
    const ppu = (Math.max(Math.min(W, H) * (16 / 9), Math.max(W, H)) * 0.5) / zoomRadius;
    const S = ppu / 16;
    const X = (x) => W / 2 + (x - cam.x) * ppu;
    const Y = (y) => H / 2 + (y - cam.y) * ppu;

    g.fillStyle = GRASS;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(0,0,0,0.15)';
    g.lineWidth = Math.max(1, ppu / 16);
    g.beginPath();
    const x0 = Math.floor((cam.x - W / 2 / ppu) / GRID) * GRID, x1 = cam.x + W / 2 / ppu;
    const y0 = Math.floor((cam.y - H / 2 / ppu) / GRID) * GRID, y1 = cam.y + H / 2 / ppu;
    for (let x = x0; x <= x1; x += GRID) { g.moveTo(X(x), 0); g.lineTo(X(x), H); }
    for (let y = y0; y <= y1; y += GRID) { g.moveTo(0, Y(y)); g.lineTo(W, Y(y)); }
    g.stroke();

    for (const p of world.players) if (!p.dead) drawPlayer(g, p, X(p.pos.x), Y(p.pos.y), S);

    // Tracers: exact port of client/src/objects/bullet.ts. The sprite is player-bullet-trail-02
    // (36x36, kept at native size by atlas-builder), anchor 0.5, scale (0.8, tracerWidth), inside a
    // container with pivot (14.5, 0) rotated to the bullet direction and scaled by
    // (camera.pixels(1) * trailLength * b.scale, camera.pixels(1)),
    // trailLength = min(tracerLength * 15, dist / 2), b.scale shrinking at 6/s after a hit.
    const camPx = ppu / 16;                // camera.m_pixels(1) = zoom
    for (const b of world.bullets) {
      const bd = b.gunDef.bullet;
      const col = (C.tracerColors[bd.tracerColor] || C.tracerColors['9mm']).regular;
      const dist = Math.hypot(b.pos.x - b.start.x, b.pos.y - b.start.y);
      const trailLength = Math.min(bd.tracerLength * 15, dist / 2);
      if (trailLength * b.scale <= 0.001) continue;
      g.save();
      g.translate(X(b.pos.x), Y(b.pos.y));
      g.rotate(Math.atan2(b.dir.y, b.dir.x));
      g.scale(camPx * trailLength * b.scale, camPx);
      g.translate(-14.5, 0);
      sprite(g, 'player-bullet-trail-02', col, 0.5, 0.5, 0.8, bd.tracerWidth);
      g.restore();
    }

    // optional training feedback: floating damage numbers
    if (extras.popups) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const q of extras.popups) {
        const a = Math.max(0, 1 - q.t / 0.8);
        g.globalAlpha = a;
        g.font = `700 ${Math.round(14 + ppu * 0.35)}px ${FONT}`;
        g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.6)';
        const tx = X(q.x), ty = Y(q.y) - q.t * ppu * 1.5;
        g.strokeText(q.text, tx, ty);
        g.fillStyle = q.head ? '#ffdd00' : '#ffffff';
        g.fillText(q.text, tx, ty);
        g.globalAlpha = 1;
      }
    }
    return { ppu, X, Y };
  };

  // ---------- HUD (survev style) ----------
  function box(g, x, y, w, h, a) { g.fillStyle = `rgba(0,0,0,${a})`; g.fillRect(x, y, w, h); }
  function text(g, s, x, y, size, o = {}) {
    g.font = `${o.weight || 700} ${size}px ${FONT}`;
    g.textAlign = o.align || 'left';
    g.textBaseline = o.base || 'alphabetic';
    if (o.shadow !== false) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillText(s, x + 1, y + 1.5); }
    g.fillStyle = o.color || '#ffffff';
    g.fillText(s, x, y);
  }

  SV.drawHud = (g, W, H, me, info) => {
    const s = Math.max(0.75, Math.min(1.25, H / 900));    // UI scale
    const pad = 14 * s;

    // weapon slots, bottom-right
    const sw = 230 * s, sh = 56 * s, gap = 6 * s;
    const keys = info.keyLabels;
    for (let k = 0; k < 3; k++) {
      const x = W - pad - sw, y = H - pad - (3 - k) * sh - (2 - k) * gap;
      const slot = me.slots[k], d = SV.defOf(slot.type);
      const sel = me.cur === k;
      box(g, x, y, sw, sh, sel ? 0.5 : 0.24);
      if (sel) { g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2 * s; g.strokeRect(x + s, y + s, sw - 2 * s, sh - 2 * s); }
      text(g, keys[k], x + 8 * s, y + 16 * s, 12 * s, { color: 'rgba(255,255,255,0.75)' });
      if (d) {
        text(g, d.name.toUpperCase(), x + 8 * s, y + sh - 10 * s, 19 * s, { color: sel ? '#fff' : 'rgba(255,255,255,0.8)' });
        const im = SV.img(d.loot);
        if (im.complete && im.naturalWidth) {
          const isz = sh * 1.05;
          g.globalAlpha = sel ? 1 : 0.7;
          g.drawImage(im, x + sw - isz - 2 * s, y + (sh - isz) / 2, isz, isz);
          g.globalAlpha = 1;
        }
        // switch / fire cooldown bar
        const maxCd = Math.max(d.switchDelay, d.kind === 'gun' ? d.fireDelay : d.attack.cooldownTime);
        if (slot.cooldown > 0) {
          g.fillStyle = sel ? '#ff6a00' : 'rgba(255,106,0,0.6)';
          g.fillRect(x, y + sh - 4 * s, sw * Math.min(1, slot.cooldown / maxCd), 4 * s);
        }
        if (d.kind === 'gun' && !sel) text(g, String(slot.ammo), x + sw - 6 * s, y + 16 * s, 12 * s, { align: 'right', color: 'rgba(255,255,255,0.75)' });
      }
    }

    // free switch indicator above slots
    {
      const x = W - pad - sw, y = H - pad - 3 * sh - 2 * gap - 34 * s;
      const ready = me.freeSwitchTimer <= 0;
      box(g, x, y, sw, 26 * s, 0.24);
      g.fillStyle = ready ? '#7dff5a' : 'rgba(255,255,255,0.35)';
      g.beginPath(); g.arc(x + 14 * s, y + 13 * s, 5 * s, 0, Math.PI * 2); g.fill();
      text(g, ready ? 'FREE SWITCH READY' : `FREE SWITCH IN ${me.freeSwitchTimer < 0 ? 0 : (me.freeSwitchTimer).toFixed(2)}S`,
        x + 26 * s, y + 18 * s, 14 * s, { color: ready ? '#fff' : 'rgba(255,255,255,0.7)' });
    }

    // ammo + health, bottom-center
    const d = me.activeDef;
    const hbW = Math.min(420 * s, W * 0.36), hbH = 22 * s;
    const hbX = (W - hbW) / 2, hbY = H - pad - hbH;
    box(g, hbX, hbY, hbW, hbH, 0.4);
    const hp = me.health / C.player.health;
    g.fillStyle = hp > 0.25 ? '#ffffff' : hp > 0 ? '#ff2828' : 'transparent';
    g.fillRect(hbX + 3 * s, hbY + 3 * s, (hbW - 6 * s) * hp, hbH - 6 * s);
    text(g, me.health.toFixed(1), W / 2, hbY + hbH / 2, 14 * s, { align: 'center', base: 'middle', color: hp > 0.55 ? '#000' : '#fff', shadow: false });
    // equipped gear, left of the health bar
    [[C.armor.helmetSkin[me.helmet], me.helmet], [C.armor.chestSkin[me.chest], me.chest]].forEach(([skin, lvl], k) => {
      if (!skin) return;
      const sz = 40 * s, x = hbX - (k + 1) * (sz + 6 * s), y = H - pad - sz;
      box(g, x, y, sz, sz, 0.4);
      const im = SV.img(skin.loot);
      if (im.complete && im.naturalWidth) g.drawImage(im, x + 3 * s, y + 3 * s, sz - 6 * s, sz - 6 * s);
      text(g, String(lvl), x + sz - 4 * s, y + sz - 4 * s, 13 * s, { align: 'right' });
    });
    // adrenaline bar above health: 4 segments sized by the breakpoints, colors from the game's CSS
    {
      const bp = C.player.boostBreakpoints, total = bp.reduce((a, b) => a + b, 0);
      const colors = ['#ff901a', '#ff751a', '#ff6616', '#ff5600'];
      const gap = 3 * s, by = hbY - 16 * s, bh = 10 * s;
      const usable = hbW - gap * (bp.length - 1);
      let bx = hbX, left = me.boost / 100;
      if (me.boost > 0) bp.forEach((b, i) => {
        const frac = b / total, w = usable * frac;
        box(g, bx, by, w, bh, 0.4);
        g.fillStyle = colors[i];
        g.fillRect(bx, by, w * Math.max(0, Math.min(1, left / frac)), bh);
        left = Math.max(left - frac, 0);
        bx += w + gap;
      });
    }
    if (d.kind === 'gun') {
      const ammo = me.slots[me.cur].ammo;
      const ax = W / 2, ay = hbY - 26 * s;
      box(g, ax - 70 * s, ay - 50 * s, 140 * s, 54 * s, 0.24);
      text(g, String(ammo), ax - 8 * s, ay - 6 * s, 44 * s, { align: 'right', color: ammo === 0 ? '#ff4040' : '#fff' });
      text(g, '∞', ax + 8 * s, ay - 10 * s, 26 * s, { color: 'rgba(255,255,255,0.75)' });
      text(g, '/' + d.maxClip, ax + 32 * s, ay - 10 * s, 16 * s, { color: 'rgba(255,255,255,0.6)' });
    }
    if (me.action) {
      const w = 180 * s, x = (W - w) / 2, y = hbY - 100 * s;
      text(g, 'RELOADING', W / 2, y - 6 * s, 15 * s, { align: 'center' });
      box(g, x, y, w, 8 * s, 0.4);
      g.fillStyle = '#fff';
      g.fillRect(x, y, w * Math.min(1, me.action.time / me.action.duration), 8 * s);
    }

    // speed, top-left
    {
      const spd = me.calcSpeed();
      box(g, pad, pad, 170 * s, 30 * s, 0.24);
      const slowed = me.shotSlowdownTimer > 0;
      text(g, `SPEED ${spd.toFixed(1)}`, pad + 10 * s, pad + 21 * s, 16 * s, { color: slowed ? '#ff6a00' : '#fff' });
      if (slowed) text(g, 'SLOWED', pad + 160 * s, pad + 21 * s, 12 * s, { align: 'right', color: '#ff6a00' });
    }

    // top-center: time + bot health + score line
    {
      const w = 320 * s, x = (W - w) / 2, y = pad;
      if (info.scope) {   // game-style scope bubble
        const r = 30 * s, cx = x - r - 10 * s, cy = y + r;
        g.fillStyle = 'rgba(0,0,0,0.24)';
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        text(g, info.scope, cx, cy + 9 * s, 26 * s, { align: 'center' });
      }
      box(g, x, y, w, 30 * s, 0.24);
      text(g, info.topLeft, x + 10 * s, y + 21 * s, 16 * s);
      text(g, info.topRight, x + w - 10 * s, y + 21 * s, 16 * s, { align: 'right' });
      if (info.bot) {
        const by = y + 36 * s, bh2 = 20 * s;
        box(g, x, by, w, bh2, 0.4);
        const bh = Math.max(0, info.bot.health / C.player.health);
        g.fillStyle = '#ff4a3a';
        g.fillRect(x + 2 * s, by + 2 * s, (w - 4 * s) * bh, bh2 - 4 * s);
        text(g, info.bot.health.toFixed(1), x + w / 2, by + bh2 / 2, 14 * s, { align: 'center', base: 'middle' });
        const gear = [info.bot.helmet ? `HELMET ${info.bot.helmet}` : '', info.bot.chest ? `VEST ${info.bot.chest}` : '',
          info.bot.boost > 0 ? `ADRENALINE ${Math.round(info.bot.boost)}` : ''].filter(Boolean).join(' · ');
        text(g, gear || 'NO ARMOR', x + w / 2, by + bh2 + 15 * s, 12 * s, { align: 'center', color: 'rgba(255,255,255,0.85)' });
      }
    }

    // timeline (last 5s of shots/switches), bottom-left
    if (info.timeline) {
      const w = 380 * s, h = 74 * s, x = pad, y = H - pad - h, span = 5, now = info.time;
      box(g, x, y, w, h, 0.3);
      text(g, 'LAST 5S', x + 8 * s, y + 15 * s, 11 * s, { color: 'rgba(255,255,255,0.7)' });
      const T = (t) => x + w - ((now - t) / span) * w;
      for (const e of info.timeline) {
        if (now - e.t > span) continue;
        const ex = T(e.t);
        if (e.type === 'shot') {
          g.fillStyle = e.slot === 0 ? '#ffffff' : e.slot === 1 ? '#ffb35a' : '#9fd8ff';
          g.fillRect(ex - 1.5 * s, y + 22 * s, 3 * s, 26 * s);
          if (e.hit) { g.fillStyle = '#7dff5a'; g.fillRect(ex - 3 * s, y + 18 * s, 6 * s, 4 * s); }
        } else if (e.type === 'switch') {
          g.fillStyle = e.free ? '#7dff5a' : '#ff4a3a';
          g.fillRect(ex - 1 * s, y + 52 * s, 2 * s, 16 * s);
          text(g, e.delay.toFixed(2), ex + 3 * s, y + 66 * s, 11 * s, { color: e.free ? '#7dff5a' : '#ff8070' });
        }
      }
    }
  };
})();
