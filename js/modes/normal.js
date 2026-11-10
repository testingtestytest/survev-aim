// NORMAL — targets spawn, grow to full size, shrink and vanish.
(function () {
  const DIFF = {
    easy:   { interval: 0.95, life: 2.8 },
    medium: { interval: 0.70, life: 2.2 },
    hard:   { interval: 0.50, life: 1.7 },
    insane: { interval: 0.35, life: 1.25 },
  };
  const SIZE = { s: 18, m: 28, l: 40 };

  AT.register({
    id: 'normal',
    name: 'NORMAL',
    description: 'Click targets before they shrink away.',
    touchDescription: 'Tap targets before they shrink away.',
    settings: [
      { key: 'difficulty', label: 'DIFFICULTY', default: 'medium',
        preview: (p) => AT.pv.lifecycle(p, DIFF[p.v], SIZE[p.cfg.size] * 0.6),
        options: [{ v: 'easy', label: 'EASY' }, { v: 'medium', label: 'MEDIUM' },
                  { v: 'hard', label: 'HARD' }, { v: 'insane', label: 'INSANE' }] },
      { key: 'size', label: 'TARGET SIZE', default: 'l', preview: AT.pv.sizes(SIZE),
        options: [{ v: 's', label: 'SMALL' }, { v: 'm', label: 'MEDIUM' }, { v: 'l', label: 'LARGE' }] },
      ...AT.endSettings(),
    ],

    create(cfg, api) {
      const D = DIFF[cfg.difficulty], R = SIZE[cfg.size];
      const targets = [];
      const st = { score: 0, hits: 0, clicks: 0, expired: 0, rt: [] };
      let t = 0, spawnT = 0;

      function spawn() {
        const b = api.bounds;
        let x, y;
        for (let i = 0; i < 25; i++) {
          x = AT.rand(b.x + R, b.x + b.w - R);
          y = AT.rand(b.y + R, b.y + b.h - R);
          if (targets.every((o) => AT.dist(o.x, o.y, x, y) > R * 2 + 6)) break;
        }
        targets.push({ x, y, born: t, life: D.life });
      }
      const radius = (o) => AT.lifeRadius((t - o.born) / o.life, R);

      return {
        update(dt) {
          t += dt;
          spawnT -= dt;
          if (spawnT <= 0) { spawn(); spawnT += D.interval; }
          for (let i = targets.length - 1; i >= 0; i--) {
            if (t - targets[i].born >= targets[i].life) {
              targets.splice(i, 1);
              st.expired++;
              api.loseLife();
            }
          }
        },
        mousedown(x, y) {
          st.clicks++;
          for (let i = targets.length - 1; i >= 0; i--) {
            const o = targets[i], r = radius(o), d = AT.dist(o.x, o.y, x, y);
            if (d <= r) {
              st.hits++;
              st.score += 100 + Math.round(50 * (1 - d / r));
              st.rt.push(t - o.born);
              api.hitFx(o.x, o.y, r);
              targets.splice(i, 1);
              return;
            }
          }
          api.missFx(x, y);
        },
        draw(g) { targets.forEach((o) => AT.drawTarget(g, o.x, o.y, radius(o))); },
        hud: () => [['SCORE', st.score], ['HITS', st.hits], ['ACC', AT.pct(st.hits, st.clicks)]],
        results: () => ({
          score: st.score,
          rows: [
            ['TARGETS HIT', st.hits],
            ['TARGETS MISSED', st.expired],
            ['CLICKS', st.clicks],
            ['ACCURACY', AT.pct(st.hits, st.clicks)],
            ['EFFICIENCY', AT.pct(st.hits, st.hits + st.expired)],
            ['HITS / MIN', AT.perMin(st.hits, t)],
            ['AVG TIME TO CLICK', AT.avgMs(st.rt)],
          ],
        }),
      };
    },
  });
})();
