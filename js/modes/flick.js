// FLICK — one target at a time; the next appears the moment you hit the current one.
(function () {
  const SIZE = { s: 14, m: 22, l: 32 };
  // [min distance px, max distance as fraction of the play-area diagonal]
  const DIST = { any: [0, 1], near: [60, 0.25], mid: [200, 0.5], far: [380, 1] };

  // Pick a spot in bounds b at a distance from (px,py) that respects DIST[key].
  function pickSpot(b, R, px, py, key, scale) {
    const minD = Math.min(DIST[key][0] * scale, Math.min(b.w, b.h) * 0.6);
    const maxD = Math.max(Math.hypot(b.w, b.h) * DIST[key][1], minD + R);
    let x, y;
    for (let i = 0; i < 60; i++) {
      x = AT.rand(b.x + R, b.x + b.w - R);
      y = AT.rand(b.y + R, b.y + b.h - R);
      const d = AT.dist(px, py, x, y);
      if (d >= minD && d <= maxD) break;
    }
    return { x, y, minD, maxD };
  }

  function previewDistance(p) {
    const s = p.s, r = 7, scale = p.w / 1400;
    const b = { x: 4, y: 26, w: p.w - 8, h: p.h - 30 };
    if (!s.cur) { s.prev = { x: p.w / 2, y: p.h / 2 + 10 }; s.cur = pickSpot(b, r, s.prev.x, s.prev.y, p.v, scale); s.t = 0; }
    s.t += p.dt;
    if (s.t > 0.75) { s.prev = s.cur; s.cur = pickSpot(b, r, s.prev.x, s.prev.y, p.v, scale); s.t = 0; }
    const g = p.g;
    if (s.cur.minD > 0) AT.ring(g, s.prev.x, s.prev.y, s.cur.minD, AT.COLORS.fg, 1);
    if (p.v !== 'any') AT.ring(g, s.prev.x, s.prev.y, s.cur.maxD, AT.COLORS.fg, 1);
    g.strokeStyle = AT.COLORS.fg; g.lineWidth = 2;
    g.beginPath(); g.moveTo(s.prev.x, s.prev.y); g.lineTo(s.cur.x, s.cur.y); g.stroke();
    AT.ring(g, s.prev.x, s.prev.y, r - 1, AT.COLORS.accent, 2);
    AT.drawTarget(g, s.cur.x, s.cur.y, r);
    AT.pv.text(g, p.v === 'any' ? 'ANYWHERE' : `NEXT SPAWNS ≥ ${DIST[p.v][0]}PX AWAY`, 10, 8, { size: 11 });
  }

  function previewTimeout(p) {
    const s = p.s, g = p.g, R = 18;
    if (s.x == null) { s.x = p.w / 2; s.t = 0; }
    s.t += p.dt;
    if (p.v && s.t >= p.v) { s.t = 0; s.x = AT.rand(R + 20, p.w - R - 20); }
    AT.drawTarget(g, s.x, p.h / 2, R);
    const bw = 120, bx = Math.max(8, Math.min(p.w - bw - 8, s.x - bw / 2)), by = p.h / 2 + R + 12;
    g.strokeStyle = AT.COLORS.fg; g.lineWidth = 2; g.strokeRect(bx, by, bw, 12);
    g.fillStyle = AT.COLORS.accent;
    g.fillRect(bx + 3, by + 3, (bw - 6) * (p.v ? 1 - s.t / p.v : 1), 6);
    AT.pv.text(g, p.v ? `${p.v}S TO HIT EACH TARGET` : 'NO TIME LIMIT', 10, 8, { size: 11 });
  }

  AT.register({
    id: 'flick',
    name: 'FLICK',
    description: 'Snap to each target as it appears.',
    settings: [
      { key: 'size', label: 'TARGET SIZE', default: 'l', preview: AT.pv.sizes(SIZE),
        options: [{ v: 's', label: 'SMALL' }, { v: 'm', label: 'MEDIUM' }, { v: 'l', label: 'LARGE' }] },
      { key: 'distance', label: 'FLICK DISTANCE', default: 'mid', preview: previewDistance,
        options: [{ v: 'any', label: 'ANY' }, { v: 'near', label: 'NEAR' }, { v: 'mid', label: 'MID' }, { v: 'far', label: 'FAR' }] },
      { key: 'timeout', label: 'TARGET TIMEOUT', default: 0, preview: previewTimeout,
        options: [{ v: 0, label: 'OFF' }, { v: 1.5, label: '1.5S' }, { v: 1, label: '1.0S' }, { v: 0.7, label: '0.7S' }] },
      ...AT.endSettings(),
    ],

    create(cfg, api) {
      const R = SIZE[cfg.size];
      const st = { score: 0, hits: 0, clicks: 0, misses: 0, timeouts: 0, rt: [] };
      let t = 0, target = null, prev = null;

      function spawn() {
        const b = api.bounds;
        const px = prev ? prev.x : b.x + b.w / 2, py = prev ? prev.y : b.y + b.h / 2;
        const s = pickSpot(b, R, px, py, cfg.distance, 1);
        target = { x: s.x, y: s.y, born: t };
      }

      return {
        update(dt) {
          t += dt;
          if (!target) spawn();
          if (cfg.timeout && t - target.born >= cfg.timeout) {
            st.timeouts++;
            api.missFx(target.x, target.y);
            prev = target;
            spawn();
            api.loseLife();
          }
        },
        mousedown(x, y) {
          if (!target) return;
          st.clicks++;
          const d = AT.dist(target.x, target.y, x, y);
          if (d <= R) {
            const rt = t - target.born;
            st.hits++;
            st.rt.push(rt);
            st.score += 100 + Math.round(50 * (1 - d / R)) + Math.max(0, Math.round((1 - rt) * 150));
            api.hitFx(target.x, target.y, R);
            prev = target;
            spawn();
          } else {
            st.misses++;
            api.missFx(x, y);
            api.loseLife();
          }
        },
        draw(g) { if (target) AT.drawTarget(g, target.x, target.y, R); },
        hud: () => [['SCORE', st.score], ['HITS', st.hits], ['ACC', AT.pct(st.hits, st.clicks)], ['AVG', AT.avgMs(st.rt)]],
        results: () => ({
          score: st.score,
          rows: [
            ['TARGETS HIT', st.hits],
            ['MISCLICKS', st.misses],
            ...(cfg.timeout ? [['TIMEOUTS', st.timeouts]] : []),
            ['ACCURACY', AT.pct(st.hits, st.clicks)],
            ['AVG REACTION', AT.avgMs(st.rt)],
            ['BEST REACTION', AT.minMs(st.rt)],
            ['HITS / MIN', AT.perMin(st.hits, t)],
          ],
        }),
      };
    },
  });
})();
