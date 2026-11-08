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
    if (p.wearingPan) {                    // client: hipSprite, drawn over the body and under the hands
      const hip = SV.MELEE.pan.hip;
      g.save();
      g.translate(hip.pos.x, hip.pos.y);
      g.rotate(hip.rot);
      sprite(g, hip.sprite, hip.tint, 0.5, 0.5, hip.scale.x, hip.scale.y);
      g.restore();
    }
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
  // client/src/objects/obstacle.ts: the sprite scales with the obstacle, and its layer decides whether it's
  // under players (rocks, zIdx 10) or over them (trees, zIdx 800). What's left of a dead one is 75% opaque.
  const PLAYER_Z = 18;
  function drawObstacles(g, list, over, X, Y, S) {
    const mine = list.filter((o) => (o.def.img.zIdx > PLAYER_Z) === over).sort((a, b) => a.scale - b.scale);
    for (const o of mine) {
      const img = o.def.img, s = o.scale * img.scale;
      g.save();
      g.globalAlpha = o.dead ? 0.75 : 1;
      g.translate(X(o.x), Y(o.y));
      g.rotate(o.rot);
      g.scale(S, S);
      sprite(g, o.dead ? img.residue : img.sprite, 0xffffff, 0.5, 0.5, s, s);
      g.restore();
    }
  }

  // client/src/objects/particles.ts: bloodSplat. Each one rolls its look the first time it's drawn.
  function drawBlood(g, world, X, Y, S) {
    const B = SV.BLOOD;
    for (const r of world.blood) {
      if (r.on && r.on.dead) continue;
      if (!r.look) {
        const a = r.dir ? Math.atan2(r.dir.y, r.dir.x) + (Math.random() - 0.5) * B.meleeSpread : 0;
        r.look = {
          img: B.images[Math.floor(Math.random() * B.images.length)],
          end: B.scaleEnd[0] + Math.random() * (B.scaleEnd[1] - B.scaleEnd[0]),
          // hsvToRgb at the game's hue gives pure red; the value is rounded so tinted copies can be reused
          tint: Math.round((B.value[0] + Math.random() * (B.value[1] - B.value[0])) * 16) * 16 * 65536 - 65536,
          rot: r.dir ? Math.random() * Math.PI * 2 : B.bulletRot,
          vx: r.dir ? Math.cos(a) : 0, vy: r.dir ? Math.sin(a) : 0,
        };
      }
      const L = r.look, age = world.time - r.born, t = Math.min(1, age / B.life);
      const drift = (1 - Math.exp(-B.drag * age));           // velocity decays with drag
      const wx = (r.on ? r.on.pos.x + r.x : r.x) + L.vx * drift, wy = (r.on ? r.on.pos.y + r.y : r.y) + L.vy * drift;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, 1 - (t - B.fadeFrom[0]) / (B.fadeFrom[1] - B.fadeFrom[0])));
      g.translate(X(wx), Y(wy));
      g.rotate(L.rot);
      g.scale(S, S);
      const sc = B.scaleStart + (L.end - B.scaleStart) * t;
      sprite(g, L.img, L.tint, 0.5, 0.5, sc, sc);
      g.restore();
    }
  }

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

    const obstacles = world.field ? world.field.near(cam.x, cam.y, Math.hypot(W, H) / 2 / ppu + 8) : [];
    drawObstacles(g, obstacles, false, X, Y, S);
    for (const p of world.players) if (!p.dead) drawPlayer(g, p, X(p.pos.x), Y(p.pos.y), S);
    if (!AT.prefs || AT.prefs.blood !== 'off') drawBlood(g, world, X, Y, S);

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

    drawObstacles(g, obstacles, true, X, Y, S);

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
    if (o.sh) { g.fillStyle = '#000'; g.fillText(s, x + o.sh, y + o.sh); }
    else if (o.shadow !== false) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillText(s, x + 1, y + 1.5); }
    g.fillStyle = o.color || '#ffffff';
    g.fillText(s, x, y);
  }

  // Centers the digits themselves on (cx, cy). A font's line box has uneven space around them, and "1" sits
  // off-center in its own width, so text alignment alone leaves numbers visibly off in their boxes.
  function mid(g, s, cx, cy, size, o = {}) {
    g.font = `${o.weight || 700} ${size}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const m = g.measureText(s);
    if (m.actualBoundingBoxAscent === undefined) return text(g, s, cx, cy, size, { ...o, align: 'center', base: 'middle' });
    text(g, s, cx + (m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2, size, { ...o, align: 'center' });
  }

  // HUD layout from survev's client/css/game.css, in CSS pixels: desktop rules, the (max-height: 768px),
  // (max-width: 1200px) shrink, and the phone rules. Shared with touch hit testing so they can't disagree.
  function hudLayout(W, H, touch) {
    if (touch) {
      const clipY = H - 78 - 32;
      return {
        touch, sc: 1,
        slotX: W - 6, slotW: 88 * 0.8333, slotWide: 88, slotH: 28,
        slotY: [92, 127, 162],
        name: { size: 10, right: 4, base: 18 }, img: 28, imgLeft: 2, number: null,
        hpW: 200, hpH: 18, hpPad: 4, hpBottom: 6, hpNum: 12,
        boost: [50, 50, 75, 25], boostH: 6, boostGap: 3, boostMargin: 0,
        clip: { x: W / 2 - 30, y: clipY, w: 60, h: 32, size: 28 },
        remain: { x: W / 2 + 34.5, y: clipY + 10, w: 44, h: 22, size: 16 },
        reload: { x: W / 2 + 92.5, y: clipY + 21, r: 11 },
        armor: { x: W < H ? 30 : W * 0.7, bottom: W < H ? 9 : 6, w: 20, h: 24, img: 18, alpha: 0.75, level: false },
        scope: { y: 6, r: 21, size: 24, append: 24 },
        pie: { y: H / 3 + (W > H ? 25 : 100), s: 0.5 },
      };
    }
    const big = H > 768 && W > 1200, s = big ? 1 : 0.85, sr = big ? 1 : 0.7;
    const armorBig = H > 768 && W > 1300, sa = armorBig ? 1 : 0.7;
    const clipY = H - 62 - 12 - 56;
    return {
      touch, sc: s,
      slotX: W - 12, slotW: 160 * sr, slotWide: 192 * sr, slotH: 60 * sr,
      slotY: [210, 140, 70].map((b) => H - 12 - (b + 60) * sr),
      name: { size: 18 * sr, right: 8 * sr, base: 54 * sr }, img: 60 * sr, imgLeft: 4 * sr, number: { size: 24 * sr, right: 8 * sr, base: 25 * sr },
      hpW: 400 * s, hpH: 32 * s, hpPad: 6 * s, hpBottom: 12, hpNum: 16 * s,
      boost: [100, 100, 150, 50].map((v) => v * s), boostH: 10 * s, boostGap: 3 * s, boostMargin: 8 * s,
      clip: { x: W / 2 - 50, y: clipY, w: 100, h: 50, size: 44 },
      remain: { x: W / 2 + 56, y: clipY + 18, w: 65, h: 32, size: 24 },
      armor: { x: W * (armorBig ? 0.71 : 0.73), bottom: 12, w: 48 * sa, h: 60 * sa, img: 36 * sa, alpha: 1, level: 16 * sa },
      scope: { y: 12, r: 32 * s, size: 32 * s, append: 24 * s },
      pie: { y: H / 3, s: 1 },
    };
  }
  const T_HIT_MARGIN = 5;              // tap area beyond the visible slot; the next slot starts 7px away
  SV.touchLayout = (W, H) => {
    const L = hudLayout(W, H, true);
    return { ...L, slots: L.slotY.map((y) => ({ x: L.slotX - L.slotW, y, w: L.slotW, h: L.slotH })) };
  };
  // Which button a tap landed on: 0-2 is a weapon slot, 'reload' reloads, null means it's for the sticks.
  SV.touchButton = (W, H, x, y, hasGun) => {
    const L = SV.touchLayout(W, H), m = T_HIT_MARGIN;
    const inside = (r) => x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
    for (let k = 0; k < 3; k++) if (inside(L.slots[k])) return k;
    if (!hasGun) return null;
    if (inside(L.clip) || inside(L.remain) || Math.hypot(x - L.reload.x, y - L.reload.y) <= L.reload.r + m * 2) return 'reload';
    return null;
  };

  function rbox(g, x, y, w, h, r, fill) {
    g.fillStyle = fill;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    g.fill();
  }

  // ui2.ts health bar colors. A full bar is grey; the color only changes at these health values.
  const HEALTH_STEPS = [[100, 179, 179, 179], [100, 255, 255, 255], [75, 255, 255, 255], [75, 255, 158, 158], [25, 255, 82, 82], [25, 255, 0, 0], [0, 255, 0, 0]];
  function healthColor(health) {
    const h = Math.ceil(health);
    let end = 0;
    while (HEALTH_STEPS[end][0] > h && end < HEALTH_STEPS.length - 1) end++;
    const a = HEALTH_STEPS[Math.max(end - 1, 0)], b = HEALTH_STEPS[end];
    const t = a[0] === b[0] ? 1 : Math.max(0, Math.min(1, (h - a[0]) / (b[0] - a[0])));
    return `rgb(${[1, 2, 3].map((i) => Math.floor(a[i] + (b[i] - a[i]) * t)).join(',')})`;
  }

  // Slot widths and opacity animate as in ui2.ts; the grey "lost health" bar trails over 1s as in game.css.
  const anim = { t: null, wide: [0, 0, 0], alpha: [0.6, 0.6, 0.6], ghost: 100 };
  function stepAnim(me, time, touch) {
    const dt = anim.t == null || time < anim.t ? 1 : Math.min(1, time - anim.t);
    anim.t = time;
    for (let k = 0; k < 3; k++) {
      const on = me.cur === k;
      const dw = (on ? 1 : 0) - anim.wide[k];
      anim.wide[k] += Math.sign(dw) * Math.min(Math.abs(dw), dt / 0.09);
      const da = (on ? 1 : 0.6) - anim.alpha[k];
      anim.alpha[k] = touch ? (on ? 1 : 0.6) : anim.alpha[k] + Math.sign(da) * Math.min(Math.abs(da), dt / 0.15);
    }
    if (me.health > anim.ghost) anim.ghost = me.health;
    else anim.ghost += (me.health - anim.ghost) * Math.min(1, dt * 3);
  }

  function drawSlots(g, me, L, info) {
    for (let k = 0; k < 3; k++) {
      const slot = me.slots[k], d = SV.defOf(slot.type), sel = me.cur === k;
      const w = L.slotW + (L.slotWide - L.slotW) * anim.wide[k], x = L.slotX - w, y = L.slotY[k], h = L.slotH;
      if (!d) continue;
      g.save();
      g.globalAlpha = anim.alpha[k];
      if (sel) rbox(g, x, y, w, h, 5, 'rgba(0,0,0,0.4)');
      const im = SV.img(d.loot);
      if (im.complete && im.naturalWidth) {
        g.save();
        g.translate(x + L.imgLeft + L.img / 2, y + h / 2);
        g.rotate(d.lootRot || 0);
        if (d.lootMirror) g.scale(-1, 1);
        g.drawImage(im, -L.img / 2, -L.img / 2, L.img, L.img);
        g.restore();
      }
      g.font = `700 ${L.name.size}px ${FONT}`;
      const name = d.name, room = w - L.imgLeft - L.img * 0.7 - L.name.right;
      const size = L.name.size * Math.min(1, room / g.measureText(name).width);
      text(g, name, x + w - L.name.right, y + L.name.base, size, { align: 'right', shadow: false });
      if (L.number) text(g, (info.keyLabels[k] || '')[0] || '', x + w - L.number.right, y + L.number.base, L.number.size, { align: 'right', shadow: false });
      g.restore();
      // Trainer addition, not in the game: how long until this weapon can fire.
      const maxCd = Math.max(d.switchDelay, d.kind === 'gun' ? d.fireDelay : d.attack.cooldownTime);
      if (slot.cooldown > 0) {
        g.fillStyle = sel ? '#ff6a00' : 'rgba(255,106,0,0.6)';
        const bar = Math.max(2, h * 0.06);
        g.fillRect(x, y + h - bar, w * Math.min(1, slot.cooldown / maxCd), bar);
      }
    }
    // Trainer addition: free switch status, directly above the slots.
    const ready = me.freeSwitchTimer <= 0, bh = L.touch ? 18 : Math.max(20, L.slotH * 0.4), bw = L.touch ? L.slotW : L.slotW;
    const bx = L.slotX - bw, by = L.slotY[0] - bh - (L.touch ? 4 : 8);
    rbox(g, bx, by, bw, bh, 5, 'rgba(0,0,0,0.24)');
    g.fillStyle = ready ? '#7dff5a' : 'rgba(255,255,255,0.35)';
    g.beginPath(); g.arc(bx + bh * 0.5, by + bh / 2, bh * 0.2, 0, Math.PI * 2); g.fill();
    const label = ready ? (L.touch ? 'FREE' : 'FREE SWITCH') : `${L.touch ? '' : 'FREE IN '}${Math.max(0, me.freeSwitchTimer).toFixed(2)}S`;
    text(g, label, bx + bh * 0.95, by + bh * 0.72, bh * 0.62, { color: ready ? '#fff' : 'rgba(255,255,255,0.75)', shadow: false });
  }

  function drawVitals(g, W, H, me, L, info) {
    // boost and health, bottom-center (#ui-bottom-center-0)
    const boxW = L.hpW + L.hpPad * 2, boxH = L.hpH + L.hpPad * 2;
    const bx = (W - boxW) / 2, by = H - L.hpBottom - boxH;
    rbox(g, bx, by, boxW, boxH, 5, 'rgba(0,0,0,0.4)');
    const ix = bx + L.hpPad, iy = by + L.hpPad, frac = Math.max(0, me.health / C.player.health);
    if (anim.ghost > me.health) rbox(g, ix, iy, L.hpW * Math.max(0, anim.ghost / 100), L.hpH, 5, '#929292');
    let fill = healthColor(me.health);
    if (me.health <= 25) {                 // .ui-bar-danger: pulses between black and red every 0.5s
      const p = (Math.sin(info.time * Math.PI * 2) + 1) / 2;
      fill = `rgba(${Math.round(255 * p)},0,0,0.8)`;
    }
    if (frac > 0) rbox(g, ix, iy, L.hpW * frac, L.hpH, 5, fill);
    // The game has no number here; you asked for one, so it stays, with one decimal.
    mid(g, me.health.toFixed(1), W / 2, iy + L.hpH / 2, L.hpNum, { color: me.health > 45 ? '#000' : '#fff', shadow: false });
    if (me.boost > 0) {
      const colors = ['#ff901a', '#ff751a', '#ff6616', '#ff5600'], total = L.boost.reduce((a, b) => a + b, 0) + L.boostGap * 3;
      const bp = C.player.boostBreakpoints, sum = bp.reduce((a, b) => a + b, 0);
      let x = (W - total) / 2, left = me.boost / 100;
      const y = by - L.boostMargin - L.boostH;
      L.boost.forEach((w, i) => {
        const part = bp[i] / sum;
        rbox(g, x, y, w, L.boostH, 2, 'rgba(0,0,0,0.4)');
        const f = Math.max(0, Math.min(1, left / part));
        if (f > 0) rbox(g, x, y, w * f, L.boostH, 2, colors[i]);
        left = Math.max(left - part, 0);
        x += w + L.boostGap;
      });
    }
    // armor, either side of 71% across the screen (#ui-bottom-center-right)
    const A = L.armor, y = H - A.bottom - A.h;
    [[C.armor.chestSkin[me.chest], me.chest, A.x + 4], [C.armor.helmetSkin[me.helmet], me.helmet, A.x - 4 - A.w]].forEach(([skin, lvl, x]) => {
      if (!skin) return;
      g.save();
      g.globalAlpha = A.alpha;
      rbox(g, x, y, A.w, A.h, 5, 'rgba(0,0,0,0.4)');
      const im = SV.img(skin.loot);
      if (im.complete && im.naturalWidth) g.drawImage(im, x + (A.w - A.img) / 2, y + (A.h - A.img) / 2, A.img, A.img);
      g.restore();
      if (A.level) text(g, `Lvl. ${lvl}`, x + A.w / 2, y - 6, A.level, { align: 'center' });
    });
  }

  function drawAmmo(g, me, L) {
    const d = me.activeDef;
    if (d.kind !== 'gun') return;
    const ammo = me.slots[me.cur].ammo, c = L.clip, r = L.remain, sh = { touch: 1, desk: 2 }[L.touch ? 'touch' : 'desk'];
    rbox(g, c.x, c.y, c.w, c.h, 5, 'rgba(0,0,0,0.4)');
    mid(g, String(ammo), c.x + c.w / 2, c.y + c.h / 2, c.size, { color: ammo > 0 ? '#fff' : '#ff0000', sh });
    rbox(g, r.x, r.y, r.w, r.h, 5, 'rgba(0,0,0,0.4)');
    // The trainer's reserve ammo is infinite, which the game also shows as a symbol.
    mid(g, '∞', r.x + r.w / 2, r.y + r.h / 2, r.size, { sh });
    if (L.reload) {
      rbox(g, L.reload.x - L.reload.r, L.reload.y - L.reload.r, L.reload.r * 2, L.reload.r * 2, L.reload.r, 'rgba(0,0,0,0.4)');
      const im = SV.img('bullets');
      if (im.complete && im.naturalWidth) g.drawImage(im, L.reload.x - 7, L.reload.y - 7, 14, 14);
    }
  }

  // ui/pieTimer.ts: the reload ring with a countdown and a label under it.
  function drawPie(g, W, me, L) {
    if (!me.action) return;
    const P = L.pie, elapsed = Math.min(me.action.time, me.action.duration), dur = me.action.duration, label = 'Reloading';
    g.save();
    g.translate(W / 2, P.y);
    g.scale(P.s, P.s);
    const im = SV.img('timer-background');
    if (im.complete && im.naturalWidth) g.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2);
    g.strokeStyle = '#fff'; g.lineWidth = 6;
    g.beginPath(); g.arc(0, 0, 35, -Math.PI / 2, (elapsed / dur) * Math.PI * 2 - Math.PI / 2); g.stroke();
    mid(g, Math.max(0, dur - elapsed).toFixed(1), 0, 0, 24, { shadow: false });
    const lw = 56 + label.length * 24 * 0.45, lh = 36;
    rbox(g, -lw / 2, 87.5 - lh / 2, lw, lh, 5, 'rgba(0,0,0,0.5)');
    text(g, label, 0, 88, 24, { align: 'center', base: 'middle', weight: 100, shadow: false });
    g.restore();
  }

  const SIDE_BOX = { w: 64, h: 44, gap: 10 };   // kills and deaths, beside the bot's health
  function drawTop(g, W, me, L, info) {
    // the current scope, top-center (.ui-zoom)
    const S = L.scope, cx = W / 2, cy = S.y + S.r;
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath(); g.arc(cx, cy, S.r, 0, Math.PI * 2); g.fill();
    const num = info.scope.replace('x', '');
    g.font = `700 ${S.size}px ${FONT}`;
    const nw = g.measureText(num).width;
    g.font = `700 ${S.append}px ${FONT}`;
    const ax = g.measureText('x').width, tx = cx - (nw + ax) / 2;
    g.font = `700 ${S.size}px ${FONT}`;
    const dm = g.measureText(num);
    const base = dm.actualBoundingBoxAscent === undefined ? cy + S.size * 0.35 : cy + (dm.actualBoundingBoxAscent - dm.actualBoundingBoxDescent) / 2;
    text(g, num, tx, base, S.size, { shadow: false });
    text(g, 'x', tx + nw, base, S.append, { shadow: false });

    const s = L.sc * (L.touch ? 0.7 : 1), pad = L.touch ? 8 : 12;
    // Trainer additions: bot health under the scope, and speed where the game shows your team.
    const bw = Math.min(320 * s, W - 2 * (L.touch ? L.slotW + 12 : 180)), bx = (W - bw) / 2;
    let by = S.y + S.r * 2 + (L.touch ? 4 : 8);
    if (L.touch) {
      rbox(g, bx, by, bw, 22, 5, 'rgba(0,0,0,0.24)');
      text(g, info.topLeft, bx + 6, by + 16, 12);
      text(g, info.topRight, bx + bw - 6, by + 16, 12, { align: 'right' });
      by += 26;
    }
    if (info.bot) {
      const h = (L.touch ? 15 : 22 * s);
      rbox(g, bx, by, bw, h, 5, 'rgba(0,0,0,0.4)');
      const f = Math.max(0, info.bot.health / C.player.health);
      if (f > 0) rbox(g, bx + 2, by + 2, (bw - 4) * f, h - 4, 3, '#ff4a3a');
      mid(g, info.bot.health.toFixed(1), W / 2, by + h / 2, h * 0.72);
      const gear = [info.bot.helmet ? `Helmet ${info.bot.helmet}` : '', info.bot.chest ? `Vest ${info.bot.chest}` : '',
        info.bot.boost > 0 ? `Adrenaline ${Math.round(info.bot.boost)}` : ''].filter(Boolean).join(' · ');
      if (gear) text(g, gear, W / 2, by + h + (L.touch ? 12 : 16 * s), L.touch ? 10 : 13 * s, { align: 'center', color: 'rgba(255,255,255,0.85)' });
    }
    const slowed = me.shotSlowdownTimer > 0, spY = L.touch && W < 600 ? S.y + S.r * 2 + 54 : pad;
    const sw = 124 * s * (L.touch ? 1.05 : 1), sh = 28 * s;
    rbox(g, pad, spY, sw, sh, 5, 'rgba(0,0,0,0.24)');
    text(g, `Speed ${me.calcSpeed().toFixed(1)}`, pad + 8 * s, spY + sh * 0.7, 17 * s, { color: slowed ? '#ff6a00' : '#fff' });
    if (L.touch && info.timeline) drawTimeline(g, info, pad, spY + sh + 6, Math.min(266, W * 0.5), 52, 0.7);

    // Time keeps the game's "Alive" box, top-right (#ui-leaderboard-wrapper). The score uses the same style,
    // smaller, either side of the bot's health.
    if (!L.touch && info.boxes) {
      const q = L.sc;
      const stat = (b, cx, y, w, h, size, labelSize) => {
        rbox(g, cx - w / 2, y, w, h, 5, 'rgba(0,0,0,0.4)');
        g.font = `700 ${size}px ${FONT}`;
        const fit = size * Math.min(1, (w - 8 * q) / g.measureText(String(b.value)).width);
        mid(g, String(b.value), cx, y + h / 2, fit, { shadow: false });
        text(g, b.label, cx, y + h + labelSize, labelSize, { align: 'center', shadow: false });
      };
      const sw = SIDE_BOX.w * q, sh = SIDE_BOX.h * q, sy = by + (22 * s) / 2 - sh / 2;
      info.boxes.forEach((b) => {
        if (b.side) stat(b, b.side === 'left' ? bx - SIDE_BOX.gap * q - sw / 2 : bx + bw + SIDE_BOX.gap * q + sw / 2, sy, sw, sh, 32 * q, 16 * q);
        else stat(b, W - 12 - (85 * q) / 2, 12, 88 * q, 80 * q, 54 * q, 24 * q);
      });
    }
  }

  // Last 5s of shots and switches.
  function drawTimeline(g, info, x, y, w, h, s) {
    const span = 5, now = info.time;
    rbox(g, x, y, w, h, 5, 'rgba(0,0,0,0.3)');
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

  SV.drawHud = (g, W, H, me, info) => {
    const L = hudLayout(W, H, !!info.touch);
    stepAnim(me, info.time, L.touch);
    drawSlots(g, me, L, info);
    drawVitals(g, W, H, me, L, info);
    drawAmmo(g, me, L);
    drawPie(g, W, me, L);
    drawTop(g, W, me, L, info);
    if (!L.touch && info.timeline) {
      const s = Math.max(0.75, Math.min(1.25, H / 900));
      drawTimeline(g, info, 12, H - 12 - 74 * s, 380 * s, 74 * s, s);
    }
  };
})();
