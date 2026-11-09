// Survev-look renderer: grass + grid, player/hand/gun sprites placed like survev's client
// (client/src/objects/player.ts + animData.ts), bullet tracers, and a game-style HUD.
(function () {
  const C = SV.CONFIG;
  const GRASS = '#80af49';                 // shared/defs/maps/baseDefs.ts biome.colors.grass
  const GRID = 16;                         // GameConfig.map.gridSize
  const SKIN = 0xf8c574;                   // outfitBase baseTint / handTint
  const FONT = '"Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  const MAX_LEVEL = 4, MIN_LEVEL = -12;    // sprite bitmap sizes, in half doublings of the sprite's own size: 4x down to 1/64

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
    if (d.kind === 'throwable') name = 'throwable';
    else if (d.kind === 'melee') name = d.anim.idlePose;
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
  function tinted(name, tint) {
    const key = name + ':' + tint;
    if (tintCache[key]) return tintCache[key];
    const im = SV.img(name);
    if (!im.complete || !im.naturalWidth) return null;
    return (tintCache[key] = { im, tint, srcW: im.naturalWidth, srcH: im.naturalHeight, levels: {} });
  }
  // The sprite drawn from its SVG, tinted PIXI-style. Sizes are made the first time they're wanted, so only the ones in
  // use take memory. It's made one size bigger than the screen needs, so plain smoothing, which is quick to draw, always
  // shrinks it by between 1.4 and 2 times. Measured against a perfect reference, that's about as smooth as the much
  // slower high quality smoothing, while a bitmap at nearly the on-screen size has visibly rougher edges when rotated.
  function bitmapAt(c, scale) {
    const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.ceil(Math.log2(scale) * 2) + 1));
    if (c.levels[level]) return c.levels[level];
    const size = 2 ** (level / 2), w = Math.max(1, Math.ceil(c.srcW * size)), h = Math.max(1, Math.ceil(c.srcH * size));
    const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const x = off.getContext('2d');
    x.drawImage(c.im, 0, 0, w, h);
    if (c.tint !== 0xffffff) {
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = '#' + c.tint.toString(16).padStart(6, '0');
      x.fillRect(0, 0, w, h);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(c.im, 0, 0, w, h);
    }
    return (c.levels[level] = off.transferToImageBitmap ? off.transferToImageBitmap() : off);
  }
  SV.preload = (names) => names.forEach((n) => n && SV.img(n));
  const hex = (n, a = 1) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

  // draw sprite with anchor (ax, ay) and scale (sx, sy) at current transform origin
  function sprite(g, name, tint, ax, ay, sx, sy) {
    const c = tinted(name, tint);
    if (!c) return;
    const w = c.srcW * sx, h = c.srcH * sy;
    const m = g.getTransform();             // real pixels per pixel of the SVG
    g.drawImage(bitmapAt(c, Math.max(Math.abs(sx) * Math.hypot(m.a, m.b), Math.abs(sy) * Math.hypot(m.c, m.d))), -w * ax, -h * ay, w, h);
  }
  // A HUD picture filling a w by h box centered on (x, y).
  function icon(g, name, x, y, w, h) {
    const c = tinted(name, 0xffffff);
    if (!c) return;
    g.translate(x, y);
    sprite(g, name, 0xffffff, 0.5, 0.5, w / c.srcW, h / c.srcH);
    g.translate(-x, -y);
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

  // client player.ts throwableState: what's in the hands depends on how far through cooking or throwing it is.
  function handGrenades(p) {
    const a = p.visAnim;
    let state = 'equip';
    if (a) for (const [at, s] of SV.ANIM.anims[a.name].state || []) if (a.t >= at) state = s;
    return SV.FRAG.handImg[state];
  }
  function drawHeld(g, h) {
    if (!h) return;
    g.save();
    g.translate(h.pos.x, h.pos.y);
    g.rotate(Math.PI / 2);
    sprite(g, h.sprite, 0xffffff, 0.5, 0.5, h.scale, h.scale);
    g.restore();
  }

  function drawHand(g, pose, gunDef, meleeWorld, meleeBone, held) {
    g.save();
    g.translate(pose.pos.x, pose.pos.y);
    g.rotate(pose.rot);
    g.translate(pose.pivot.x, pose.pivot.y);
    if (gunDef && !gunDef.world.handsBelow) drawGun(g, gunDef);
    if (meleeWorld && !meleeWorld.renderOnHand) drawMelee(g, meleeWorld, meleeBone);
    sprite(g, 'player-hands-01', SKIN, 0.5, 0.5, 0.175, 0.175);
    if (meleeWorld && meleeWorld.renderOnHand) drawMelee(g, meleeWorld, meleeBone);
    if (gunDef && gunDef.world.handsBelow) drawGun(g, gunDef);
    drawHeld(g, held);
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
    if (p.safeT > 0) g.globalAlpha = 0.5;  // just lost a life, and can't be hurt yet
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
    const held = d.kind === 'throwable' ? handGrenades(p) : null;
    const drawL = () => drawHand(g, L, gun && gun.isDual ? gun : null, null, null, held && held.left);
    const drawR = () => drawHand(g, R, gun, meleeWorld, bones[MELEE_R], held && held.right);
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
  function drawObstacles(g, list, over, X, Y, S, W, H) {
    // What's left of a dead one is on the ground, under players, even for trees, which stand over them while alive.
    const mine = list.filter((o) => (!o.dead && o.def.img.zIdx > PLAYER_Z) === over).sort((a, b) => a.scale - b.scale);
    for (const o of mine) {
      const img = o.def.img, s = o.scale * img.scale, sx = X(o.x), sy = Y(o.y);
      const c = tinted(img.sprite, 0xffffff), half = c ? (c.srcW / 2) * s * S : 0;
      if (sx + half < 0 || sx - half > W || sy + half < 0 || sy - half > H) continue;   // off screen
      g.save();
      g.globalAlpha = o.dead ? 0.75 : 1;
      g.translate(sx, sy);
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

  // client objects/projectile.ts: grows with height, low ones under players and high ones over them.
  function drawProjectiles(g, world, high, X, Y, S) {
    const I = SV.FRAG.worldImg;
    for (const q of world.projectiles) {
      if ((q.z >= 0.25) !== high) continue;
      const s = I.scale * remap(q.z, 0, C.projectileMaxHeight, 1, 4.75);
      g.save();
      g.translate(X(q.pos.x), Y(q.pos.y));
      g.rotate(q.rot);
      g.scale(S, S);
      sprite(g, I.sprite, 0xffffff, 0.5, 0.5, s, s);
      g.restore();
    }
  }
  const remap = (v, a, b, x, y) => x + ((Math.max(a, Math.min(b, v)) - a) / (b - a)) * (y - x);
  const BURST_TINT = 0xfb6200;             // particles.ts explosionBurst: hsvToRgb(0.065, 1, 0.98)
  const SHAKE = { str: 0.2, dur: 0.35, near: 10, far: 40 };   // explosion.ts frag, camera.ts addShake
  // client objects/obstacle.ts: 5 to 10 pieces thrown out when something breaks, and particles.ts rockBreak and woodLog.
  const DEBRIS = {
    stone: { image: 'map-stone-01', life: [0.8, 1], drag: [1, 5], rotVel: 0, start: [0.07, 0.12], end: [0.05, 0.1], tint: (v) => [v, v, v], value: [0.5, 0.75] },
    tree: { image: 'part-log-01', life: [1, 1.5], drag: [1, 5], rotVel: Math.PI * 3, start: [0.1, 0.2], end: [0.08, 0.18], tint: (v) => [v, v * 0.3, 0], value: [0.35, 0.45] },
  };
  const DEBRIS_FADE = [0.9, 1], DEBRIS_COUNT = [5, 11], DEBRIS_SPEED = [5, 15];
  const between = (r) => r[0] + Math.random() * (r[1] - r[0]);
  function spawnDebris(world) {
    const f = world.field;
    if (!f || !f.broken.length) return;
    for (const o of f.broken) {
      const D = DEBRIS[o.kind];
      if (!D) continue;
      const count = Math.floor(between(DEBRIS_COUNT));
      for (let n = 0; n < count; n++) {
        const a = Math.random() * Math.PI * 2, sp = between(DEBRIS_SPEED);
        // the value is rounded so tinted copies can be reused
        const v = Math.round(between(D.value) * 20) / 20, c = D.tint(v).map((q) => Math.round(q * 255));
        world.debris.push({ D, x: o.x, y: o.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, born: world.time, life: between(D.life), drag: between(D.drag), rot: Math.random() * Math.PI * 2,
          start: between(D.start), end: between(D.end), tint: (c[0] << 16) | (c[1] << 8) | c[2] });
      }
    }
    f.broken.length = 0;
  }
  function drawDebris(g, world, X, Y, S) {
    spawnDebris(world);
    if (!world.debris.length) return;
    world.debris = world.debris.filter((q) => world.time - q.born < q.life);
    for (const q of world.debris) {
      const age = world.time - q.born, t = age / q.life, go = (1 - Math.exp(-q.drag * age)) / q.drag, s = q.start + (q.end - q.start) * t;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, 1 - (t - DEBRIS_FADE[0]) / (DEBRIS_FADE[1] - DEBRIS_FADE[0])));
      g.translate(X(q.x + q.vx * go), Y(q.y + q.vy * go));
      g.rotate(q.rot + q.D.rotVel * age);
      g.scale(S, S);
      sprite(g, q.D.image, q.tint, 0.5, 0.5, s, s);
      g.restore();
    }
  }
  function drawDecals(g, world, X, Y, S) {
    const D = SV.FRAG.decal;
    for (const q of world.decals) {
      g.save();
      g.globalAlpha = D.alpha;
      g.translate(X(q.x), Y(q.y));
      g.rotate(q.rot);
      g.scale(S, S);
      sprite(g, D.sprite, 0x000000, 0.5, 0.5, D.scale, D.scale);
      g.restore();
    }
  }
  function drawBooms(g, world, X, Y, S) {
    const B = SV.FRAG.burst;
    for (const q of world.booms) {
      const t = Math.min(1, (world.time - q.born) / B.life), s = B.scale[0] + (B.scale[1] - B.scale[0]) * t;
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, 1 - (t - B.fadeFrom[0]) / (B.fadeFrom[1] - B.fadeFrom[0])));
      g.translate(X(q.x), Y(q.y));
      g.scale(S, S);
      sprite(g, B.image, BURST_TINT, 0.5, 0.5, s, s);
      g.restore();
    }
  }
  function shakeOf(world, cam) {
    let int = 0;
    for (const q of world.booms) {
      const k = Math.max(0, Math.min(1, (SHAKE.far - Math.hypot(cam.x - q.x, cam.y - q.y)) / (SHAKE.far - SHAKE.near)));
      int = Math.max(int, SHAKE.str * (1 - Math.min(1, (world.time - q.born) / SHAKE.dur)) * k);
    }
    return int;
  }

  SV.drawWorld = (g, W, H, world, cam, zoomRadius, extras = {}) => {
    const shake = world.booms.length ? shakeOf(world, cam) : 0;
    if (shake > 0) { const a = Math.random() * Math.PI * 2; cam = { x: cam.x + Math.cos(a) * shake, y: cam.y + Math.sin(a) * shake }; }
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
    drawDecals(g, world, X, Y, S);
    drawObstacles(g, obstacles, false, X, Y, S, W, H);
    drawProjectiles(g, world, false, X, Y, S);
    for (const p of world.players) if (!p.dead) drawPlayer(g, p, X(p.pos.x), Y(p.pos.y), S);
    drawProjectiles(g, world, true, X, Y, S);
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

    drawDebris(g, world, X, Y, S);
    drawBooms(g, world, X, Y, S);
    drawObstacles(g, obstacles, true, X, Y, S, W, H);

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
  const T_HIT_MARGIN = 5;              // tap area beyond the visible slot; the next slot starts 7px away
  function hudLayout(W, H, touch) {
    if (touch) {
      const clipY = H - 78 - 32;
      return {
        touch, sc: 1,
        slotX: W - 6, slotW: 88 * 0.8333, slotWide: 88, slotH: 28,
        slotY: [92, 127, 162, 197],
        name: { size: 10, right: 4, base: 18 }, img: 28, imgLeft: 2, number: null,
        hpW: 200, hpH: 18, hpPad: 4, hpBottom: 6, hpNum: 12,
        boost: [50, 50, 75, 25], boostH: 6, boostGap: 3, boostMargin: 0,
        clip: { x: W / 2 - 30, y: clipY, w: 60, h: 32, size: 28 },
        remain: { x: W / 2 + 34.5, y: clipY + 10, w: 44, h: 22, size: 16 },
        reload: { x: W / 2 + 92.5, y: clipY + 21, r: 11 },
        armor: { x: W < H ? 30 : W * 0.7, bottom: W < H ? 9 : 6, w: 20, h: 24, img: 18, alpha: 0.75, level: false },
        scope: { y: 6, r: 21, size: 24, append: 24, gap: 8, idle: 0.6, idleAlpha: 0.3, hit: T_HIT_MARGIN },
        pie: { y: H / 3 + (W > H ? 25 : 100), s: 0.5 },
      };
    }
    const big = H > 768 && W > 1200, s = big ? 1 : 0.85, sr = big ? 1 : 0.7;
    const armorBig = H > 768 && W > 1300, sa = armorBig ? 1 : 0.7;
    const clipY = H - 62 - 12 - 56;
    return {
      touch, sc: s,
      slotX: W - 12, slotW: 160 * sr, slotWide: 192 * sr, slotH: 60 * sr,
      slotY: [210, 140, 70, 0].map((b) => H - 12 - (b + 60) * sr),
      name: { size: 18 * sr, right: 8 * sr, base: 54 * sr }, img: 60 * sr, imgLeft: 4 * sr, number: { size: 24 * sr, right: 8 * sr, base: 25 * sr },
      hpW: 400 * s, hpH: 32 * s, hpPad: 6 * s, hpBottom: 12, hpNum: 16 * s,
      boost: [100, 100, 150, 50].map((v) => v * s), boostH: 10 * s, boostGap: 3 * s, boostMargin: 8 * s,
      clip: { x: W / 2 - 50, y: clipY, w: 100, h: 50, size: 44 },
      remain: { x: W / 2 + 56, y: clipY + 18, w: 65, h: 32, size: 24 },
      armor: { x: W * (armorBig ? 0.71 : 0.73), bottom: 12, w: 48 * sa, h: 60 * sa, img: 36 * sa, alpha: 1, level: 16 * sa },
      scope: { y: 12, r: 32 * s, size: 32 * s, append: 24 * s, gap: 8 * s, idle: 0.5, idleAlpha: 0.6, hit: 2 },
      pie: { y: H / 3, s: 1 },
    };
  }
  // #ui-top-center-scopes: a centered row where the scope in use is full size and the others are smaller and overlap
  // its margins. on[k] is how far each one has grown, from 0 to 1. Returns each button's center and radius.
  function scopeRow(W, S, on) {
    const widths = on.map((v) => S.r * 2 - S.gap * 2 * (1 - v));
    let x = W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
    return on.map((v, k) => {
      const q = S.idle + (1 - S.idle) * v, cx = x + widths[k] / 2;
      x += widths[k];
      return { cx, cy: S.y + S.r, r: S.r * q, q, v };
    });
  }
  // #ui-medical-interactive: a column of healing and adrenaline items, right of center. Phones have the weapons
  // down that side, so the column sits just to their left there.
  function itemBoxes(W, H, touch, ids) {
    const L = hudLayout(W, H, touch), bw = touch ? 58 : 85, bh = touch ? 26 : 32, gap = touch ? 4 : 5;
    const x = touch ? L.slotX - L.slotWide - 6 - bw : W - 12 - bw;
    const y = touch ? L.slotY[0] : H * 0.4 - (ids.length * (bh + gap) - gap) / 2;
    return ids.map((id, k) => ({ id, x, y: y + k * (bh + gap), w: bw, h: bh }));
  }
  // Which item button is at this point of the screen, or null.
  SV.itemAt = (W, H, touch, x, y) => {
    const m = touch ? 2 : 0;
    const b = itemBoxes(W, H, touch, Object.keys(SV.ITEMS)).find((q) => x >= q.x - m && x <= q.x + q.w + m && y >= q.y - m && y <= q.y + q.h + m);
    return b ? b.id : null;
  };
  // Which scope is at this point of the screen, or null.
  SV.scopeAt = (W, H, touch, scopes, cur, x, y) => {
    const S = hudLayout(W, H, touch).scope;
    const row = scopeRow(W, S, scopes.map((n) => (n === cur ? 1 : 0)));
    const k = row.findIndex((b) => Math.hypot(x - b.cx, y - b.cy) <= b.r + S.hit);
    return k < 0 ? null : scopes[k];
  };
  SV.touchLayout = (W, H) => {
    const L = hudLayout(W, H, true);
    return { ...L, slots: L.slotY.map((y) => ({ x: L.slotX - L.slotW, y, w: L.slotW, h: L.slotH })) };
  };
  // Which button a tap landed on: 0-2 is a weapon slot, 'reload' reloads, null means it's for the sticks.
  SV.touchButton = (W, H, x, y, hasGun, hasNade) => {
    const L = SV.touchLayout(W, H), m = T_HIT_MARGIN;
    const inside = (r) => x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
    for (let k = 0; k < (hasNade ? 4 : 3); k++) if (inside(L.slots[k])) return k;
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
  const anim = { t: null, dt: 0, wide: [0, 0, 0, 0], alpha: [0.6, 0.6, 0.6, 0.6], ghost: 100, scopeOn: null };
  function stepAnim(me, time, touch) {
    const dt = anim.t == null || time < anim.t ? 1 : Math.min(1, time - anim.t);
    anim.t = time;
    anim.dt = dt;
    for (let k = 0; k < 4; k++) {
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
    for (let k = 0; k < 4; k++) {
      const slot = me.slots[k], d = SV.defOf(slot.type), sel = me.cur === k;
      const w = L.slotW + (L.slotWide - L.slotW) * anim.wide[k], x = L.slotX - w, y = L.slotY[k], h = L.slotH;
      if (!d) continue;
      g.save();
      g.globalAlpha = anim.alpha[k];
      if (sel) rbox(g, x, y, w, h, 5, 'rgba(0,0,0,0.4)');
      g.save();
      g.translate(x + L.imgLeft + L.img / 2, y + h / 2);
      g.rotate(d.lootRot || 0);
      if (d.lootMirror) g.scale(-1, 1);
      icon(g, d.loot, 0, 0, L.img, L.img);
      g.restore();
      g.font = `700 ${L.name.size}px ${FONT}`;
      const name = d.kind === 'throwable' ? `Frag x${me.nades}` : d.name, room = w - L.imgLeft - L.img * 0.7 - L.name.right;
      const size = L.name.size * Math.min(1, room / g.measureText(name).width);
      text(g, name, x + w - L.name.right, y + L.name.base, size, { align: 'right', shadow: false });
      if (L.number) text(g, (info.keyLabels[k] || '')[0] || '', x + w - L.number.right, y + L.number.base, L.number.size, { align: 'right', shadow: false });
      g.restore();
      // Trainer addition, not in the game: how long until this weapon can fire.
      const maxCd = Math.max(d.switchDelay, d.kind === 'gun' ? d.fireDelay : d.kind === 'melee' ? d.attack.cooldownTime : C.player.baseSwitchDelay);
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
      icon(g, skin.loot, x + A.w / 2, y + A.h / 2, A.img, A.img);
      g.restore();
      if (A.level) text(g, `Lvl. ${lvl}`, x + A.w / 2, y - 6, A.level, { align: 'center' });
    });
  }

  function drawAmmo(g, me, L) {
    const d = me.activeDef;
    if (d.kind === 'throwable') {           // ui2.ts: the clip box counts what you're holding
      rbox(g, L.clip.x, L.clip.y, L.clip.w, L.clip.h, 5, 'rgba(0,0,0,0.4)');
      mid(g, String(me.nades), L.clip.x + L.clip.w / 2, L.clip.y + L.clip.h / 2, L.clip.size, { sh: L.touch ? 1 : 2 });
      return;
    }
    if (d.kind !== 'gun') return;
    const ammo = me.slots[me.cur].ammo, c = L.clip, r = L.remain, sh = { touch: 1, desk: 2 }[L.touch ? 'touch' : 'desk'];
    rbox(g, c.x, c.y, c.w, c.h, 5, 'rgba(0,0,0,0.4)');
    mid(g, me.infiniteAmmo ? '∞' : String(ammo), c.x + c.w / 2, c.y + c.h / 2, c.size, { color: ammo > 0 ? '#fff' : '#ff0000', sh });
    rbox(g, r.x, r.y, r.w, r.h, 5, 'rgba(0,0,0,0.4)');
    // The trainer's reserve ammo is infinite, which the game also shows as a symbol.
    mid(g, '∞', r.x + r.w / 2, r.y + r.h / 2, r.size, { sh });
    if (L.reload) {
      rbox(g, L.reload.x - L.reload.r, L.reload.y - L.reload.r, L.reload.r * 2, L.reload.r * 2, L.reload.r, 'rgba(0,0,0,0.4)');
      icon(g, 'bullets', L.reload.x, L.reload.y, 14, 14);
    }
  }

  function drawItems(g, W, H, me, L, info) {
    const using = me.action && me.action.type === 'use' ? me.action.item : null;
    for (const b of itemBoxes(W, H, L.touch, Object.keys(SV.ITEMS))) {
      const d = SV.ITEMS[b.id], hover = info.mouse && !L.touch && info.mouse.x >= b.x && info.mouse.x <= b.x + b.w && info.mouse.y >= b.y && info.mouse.y <= b.y + b.h;
      g.save();
      g.globalAlpha = hover || using === b.id ? 1 : 0.75;     // #ui-right-center
      rbox(g, b.x, b.y, b.w, b.h, 5, 'rgba(0,0,0,0.4)');
      if (using === b.id) { g.strokeStyle = '#00ff00'; g.lineWidth = 2; g.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2); }   // .ui-outline-hover
      icon(g, d.loot, b.x + b.w - 5 - (b.h - 2) / 2, b.y + b.h / 2, b.h - 2, b.h - 2);
      mid(g, '∞', b.x + (b.w - b.h) / 2, b.y + b.h / 2, L.touch ? 16 : 20, { shadow: false });
      g.restore();
    }
  }

  // ui/pieTimer.ts: the reload ring with a countdown and a label under it.
  function drawPie(g, W, me, L) {
    if (!me.action) return;
    const P = L.pie, elapsed = Math.min(me.action.time, me.action.duration), dur = me.action.duration, label = me.action.type === 'use' ? `Using ${SV.ITEMS[me.action.item].name}` : 'Reloading';
    g.save();
    g.translate(W / 2, P.y);
    g.scale(P.s, P.s);
    const pie = tinted('timer-background', 0xffffff);
    if (pie) icon(g, 'timer-background', 0, 0, pie.srcW, pie.srcH);
    g.strokeStyle = '#fff'; g.lineWidth = 6;
    g.beginPath(); g.arc(0, 0, 35, -Math.PI / 2, (elapsed / dur) * Math.PI * 2 - Math.PI / 2); g.stroke();
    mid(g, Math.max(0, dur - elapsed).toFixed(1), 0, 0, 24, { shadow: false });
    const lw = 56 + label.length * 24 * 0.45, lh = 36;
    rbox(g, -lw / 2, 87.5 - lh / 2, lw, lh, 5, 'rgba(0,0,0,0.5)');
    text(g, label, 0, 88, 24, { align: 'center', base: 'middle', weight: 100, shadow: false });
    g.restore();
  }

  // The scope buttons (.ui-zoom). The one in use grows over 100ms, and the mouse brightens the others (.ui-zoom-inactive:hover).
  const scopeText = {};                // measured once per label and size: this runs every frame
  function drawScopes(g, W, L, info) {
    const S = L.scope, on = anim.scopeOn && anim.scopeOn.length === info.scopes.length ? anim.scopeOn : (anim.scopeOn = info.scopes.map((n) => (n === info.scope ? 1 : 0)));
    info.scopes.forEach((n, k) => { const d = (n === info.scope ? 1 : 0) - on[k]; on[k] += Math.sign(d) * Math.min(Math.abs(d), anim.dt / 0.1); });
    scopeRow(W, S, on).forEach((b, k) => {
      const num = info.scopes[k].replace('xscope', ''), key = num + ':' + S.size;
      if (!scopeText[key]) {
        g.font = `700 ${S.size}px ${FONT}`;
        const m = g.measureText(num), nw = m.width;
        g.font = `700 ${S.append}px ${FONT}`;
        const ax = g.measureText('x').width;
        scopeText[key] = { nw, left: -(nw + ax) / 2, drop: m.actualBoundingBoxAscent === undefined ? S.size * 0.35 : (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 };
      }
      const t = scopeText[key], hover = info.mouse && !L.touch && Math.hypot(info.mouse.x - b.cx, info.mouse.y - b.cy) <= b.r;
      g.save();
      g.globalAlpha = hover ? 1 : S.idleAlpha + (1 - S.idleAlpha) * b.v;
      g.translate(b.cx, b.cy);
      g.scale(b.q, b.q);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.beginPath(); g.arc(0, 0, S.r, 0, Math.PI * 2); g.fill();
      text(g, num, t.left, t.drop, S.size, { shadow: false });
      text(g, 'x', t.left + t.nw, t.drop, S.append, { shadow: false });
      g.restore();
    });
  }

  const SIDE_BOX = { w: 64, h: 44, gap: 10 };   // kills and deaths, beside the bot's health
  function drawTop(g, W, me, L, info) {
    drawScopes(g, W, L, info);
    const S = L.scope;

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
    drawItems(g, W, H, me, L, info);
    drawTop(g, W, me, L, info);
    if (!L.touch && info.timeline) {
      const s = Math.max(0.75, Math.min(1.25, H / 900));
      drawTimeline(g, info, 12, H - 12 - 74 * s, 380 * s, 74 * s, s);
    }
  };
})();
