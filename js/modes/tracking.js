// TRACKING — hold LMB and keep the crosshair on a moving target.
(function () {
  const SIZE = { s: 16, m: 26, l: 38 };
  const SPEED = { slow: 160, medium: 280, fast: 420 };

  // Scaled-down mover with a trail, so smooth vs strafe vs speed is visible.
  function previewMotion(p, pattern, speed) {
    const s = p.s, g = p.g, R = 9, k = 0.4;
    const b = { x: 0, y: 0, w: p.w, h: p.h };
    if (!s.m) { s.m = AT.makeMover(pattern, p.w / 2, p.h / 2); s.trail = []; s.t = 0; }
    s.t += p.dt;
    s.m.step(p.dt, b, R, speed * k);
    s.trail.push({ x: s.m.x, y: s.m.y, t: s.t });
    while (s.trail.length && s.t - s.trail[0].t > 1.2) s.trail.shift();
    g.strokeStyle = AT.COLORS.fg; g.lineWidth = 2; g.beginPath();
    s.trail.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
    g.stroke();
    AT.drawTarget(g, s.m.x, s.m.y, R);
  }

  AT.register({
    id: 'tracking',
    name: 'TRACKING',
    description: 'Keep your crosshair on a moving target.',
    touchDescription: 'Keep your finger on a moving target.',
    settings: [
      { key: 'pattern', label: 'MOVEMENT', default: 'strafe',
        preview: (p) => previewMotion(p, p.v, SPEED[p.cfg.speed]),
        options: [{ v: 'smooth', label: 'SMOOTH' }, { v: 'strafe', label: 'STRAFE' }, { v: 'mixed', label: 'MIXED' }] },
      { key: 'speed', label: 'SPEED', default: 'medium',
        preview: (p) => previewMotion(p, p.cfg.pattern, SPEED[p.v]),
        options: [{ v: 'slow', label: 'SLOW' }, { v: 'medium', label: 'MEDIUM' }, { v: 'fast', label: 'FAST' }] },
      { key: 'size', label: 'TARGET SIZE', default: 'l', preview: AT.pv.sizes(SIZE),
        options: [{ v: 's', label: 'SMALL' }, { v: 'm', label: 'MEDIUM' }, { v: 'l', label: 'LARGE' }] },
      { key: 'duration', label: 'DURATION', default: 30, preview: AT.pv.duration,
        options: [15, 30, 60, 120].map((v) => ({ v, label: v + 'S' })) },
    ],

    create(cfg, api) {
      const R = SIZE[cfg.size], speed = SPEED[cfg.speed], b0 = api.bounds;
      const m = AT.makeMover(cfg.pattern, b0.x + b0.w / 2, b0.y + b0.h / 2);
      let t = 0, onT = 0, streak = 0, bestStreak = 0, on = false;

      return {
        update(dt) {
          t += dt;
          m.step(dt, api.bounds, R, speed);
          const ms = api.mouse;
          on = ms.down && AT.dist(ms.x, ms.y, m.x, m.y) <= R;
          if (on) { onT += dt; streak += dt; bestStreak = Math.max(bestStreak, streak); }
          else streak = 0;
        },
        mousedown() {},
        draw(g) {
          AT.drawTarget(g, m.x, m.y, R);
          if (on) AT.ring(g, m.x, m.y, R + 6, AT.COLORS.fg, 3);
        },
        hud: () => [['ON TARGET', AT.pct(onT, t)], ['STREAK', streak.toFixed(1) + 'S']],
        results: () => ({
          score: Math.round(onT * 100),
          rows: [
            ['TRACKING ACCURACY', AT.pct(onT, t)],
            ['TIME ON TARGET', onT.toFixed(1) + 'S'],
            ['LONGEST STREAK', bestStreak.toFixed(1) + 'S'],
          ],
        }),
      };
    },
  });
})();
