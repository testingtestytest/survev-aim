// Shared helpers, mode registry, movement model, setting previews, crosshair builder.
(function () {
  const AT = (window.AT = { modes: [] });

  AT.COLORS = { bg: '#FFFFFF', fg: '#000000', accent: '#FF6A00' };
  AT.register = (mode) => AT.modes.push(mode);

  AT.store = {
    get(k, d) {
      try { const v = localStorage.getItem('aim:' + k); return v == null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('aim:' + k, JSON.stringify(v)); } catch (e) {}
    },
  };

  AT.rand = (a, b) => a + Math.random() * (b - a);
  AT.dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  AT.pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
  AT.avgMs = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 1000) + 'MS' : '—');
  AT.minMs = (arr) => (arr.length ? Math.round(Math.min(...arr) * 1000) + 'MS' : '—');
  AT.perMin = (n, sec) => (sec > 0 ? (n / (sec / 60)).toFixed(1) : '—');

  // Solid flat target.
  AT.drawTarget = (g, x, y, r, color) => {
    if (r <= 0.5) return;
    g.fillStyle = color || AT.COLORS.accent;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  AT.ring = (g, x, y, r, color, lw) => {
    g.strokeStyle = color; g.lineWidth = lw;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  };

  // ---------- movement model (used by tracking + its previews) ----------
  // pattern: 'smooth' (curving), 'strafe' (8-way snaps + short stops), 'mixed' (alternates)
  AT.makeMover = (pattern, x, y) => {
    const m = {
      x, y,
      a: AT.rand(0, Math.PI * 2), w: 0, moving: true,
      cur: pattern === 'mixed' ? 'strafe' : pattern,
      changeT: 0, patternT: AT.rand(2, 4),
    };
    function steer() {
      if (m.cur === 'smooth') {
        m.w = AT.rand(-3, 3); m.moving = true; m.changeT = AT.rand(0.5, 1.5);
      } else {
        if (Math.random() < 0.12) { m.moving = false; m.changeT = AT.rand(0.15, 0.35); return; }
        const old = m.a;
        let k;
        do { k = Math.floor(Math.random() * 8); } while (Math.abs(k * Math.PI / 4 - old) < 0.01);
        m.a = k * Math.PI / 4; m.moving = true; m.changeT = AT.rand(0.15, 0.7);
      }
    }
    m.step = (dt, b, R, speed) => {
      if (pattern === 'mixed' && (m.patternT -= dt) <= 0) {
        m.cur = m.cur === 'strafe' ? 'smooth' : 'strafe';
        m.patternT = AT.rand(2, 4); m.changeT = 0;
      }
      if ((m.changeT -= dt) <= 0) steer();
      if (m.cur === 'smooth') m.a += m.w * dt;
      if (m.moving) { m.x += Math.cos(m.a) * speed * dt; m.y += Math.sin(m.a) * speed * dt; }
      if (m.x < b.x + R) { m.x = b.x + R; m.a = Math.PI - m.a; }
      if (m.x > b.x + b.w - R) { m.x = b.x + b.w - R; m.a = Math.PI - m.a; }
      if (m.y < b.y + R) { m.y = b.y + R; m.a = -m.a; }
      if (m.y > b.y + b.h - R) { m.y = b.y + b.h - R; m.a = -m.a; }
    };
    return m;
  };

  // ---------- setting previews ----------
  // A setting may have preview(p): p = { g, w, h, v (selected value), cfg, dt, s (state, reset on change) }
  const pv = (AT.pv = {});
  pv.text = (g, str, x, y, o = {}) => {
    g.font = `${o.weight || 800} ${o.size || 13}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
    g.fillStyle = o.color || AT.COLORS.fg;
    g.textAlign = o.align || 'left';
    g.textBaseline = o.base || 'top';
    g.fillText(str, x, y);
  };

  // All sizes side by side at real pixel size; the selected one is solid.
  pv.sizes = (map) => (p) => {
    const keys = Object.keys(map), gap = 18;
    const total = keys.reduce((a, k) => a + map[k] * 2, 0) + gap * (keys.length - 1);
    let x = (p.w - total) / 2;
    keys.forEach((k) => {
      const r = map[k];
      x += r;
      if (k === p.v) AT.drawTarget(p.g, x, p.h / 2, r);
      else AT.ring(p.g, x, p.h / 2, r - 1, AT.COLORS.fg, 2);
      x += r + gap;
    });
    pv.text(p.g, 'ACTUAL SIZE', 10, 10, { size: 11 });
  };

  // Target radius over its life (p = 0..1): grow, hold big, shrink to small, hold small, vanish.
  const ease = (x) => x * x * (3 - 2 * x);
  const SMALL = 0.35;
  AT.lifeRadius = (p, R) => {
    if (p <= 0 || p >= 1) return 0;
    if (p < 0.18) return R * ease(p / 0.18);
    if (p < 0.5) return R;
    if (p < 0.65) return R * (1 - (1 - SMALL) * ease((p - 0.5) / 0.15));
    if (p < 0.85) return R * SMALL;
    return R * SMALL * (1 - ease((p - 0.85) / 0.15));
  };

  // Mini simulation of grow/shrink targets.
  pv.lifecycle = (p, D, R) => {
    const s = p.s;
    if (!s.ts) { s.ts = []; s.t = 0; s.spawnT = 0; }
    s.t += p.dt; s.spawnT -= p.dt;
    if (s.spawnT <= 0) {
      s.spawnT += D.interval;
      s.ts.push({ x: AT.rand(R + 4, p.w - R - 4), y: AT.rand(R + 30, p.h - R - 4), born: s.t });
    }
    s.ts = s.ts.filter((o) => s.t - o.born < D.life);
    s.ts.forEach((o) => AT.drawTarget(p.g, o.x, o.y, AT.lifeRadius((s.t - o.born) / D.life, R)));
    pv.text(p.g, `LIFE ${D.life}S · NEW EVERY ${D.interval}S`, 10, 10, { size: 11 });
  };

  pv.bar = (p, frac, label) => {
    const { g, w, h } = p, x = 16, bw = w - 32, y = h / 2 + 4, bh = 22;
    g.strokeStyle = AT.COLORS.fg; g.lineWidth = 2; g.strokeRect(x, y, bw, bh);
    g.fillStyle = AT.COLORS.accent; g.fillRect(x + 4, y + 4, Math.max(0, (bw - 8) * frac), bh - 8);
    pv.text(g, label, x, y - 30, { size: 20 });
  };

  pv.squares = (p, total, full, label) => {
    const { g, w, h } = p, size = Math.min(22, (w - 32 - (total - 1) * 6) / total);
    const tw = total * size + (total - 1) * 6;
    let x = (w - tw) / 2; const y = h / 2 + 4;
    for (let i = 0; i < total; i++) {
      if (i < full) { g.fillStyle = AT.COLORS.accent; g.fillRect(x, y, size, size); }
      else { g.strokeStyle = AT.COLORS.accent; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3); }
      x += size + 6;
    }
    pv.text(g, label, 16, y - 30, { size: 20 });
  };

  pv.endCond = (p) => {
    const s = p.s; s.t = ((s.t || 0) + p.dt) % 4;
    if (p.v === 'time') pv.bar(p, 1 - s.t / 4, 'TIMER RUNS OUT');
    else pv.squares(p, 3, 3 - Math.floor(s.t / 1.33), 'LIVES RUN OUT');
  };
  pv.duration = (p) => pv.bar(p, p.v / 120, p.v + ' SECONDS');
  pv.lives = (p) => pv.squares(p, p.v, p.v, p.v + (p.v === 1 ? ' LIFE' : ' LIVES'));

  // Common "how does the round end" settings.
  AT.endSettings = () => [
    { key: 'end', label: 'END CONDITION', default: 'time', preview: pv.endCond,
      options: [{ v: 'time', label: 'TIMER' }, { v: 'lives', label: 'LIVES' }] },
    { key: 'duration', label: 'DURATION', default: 30, when: (c) => c.end === 'time', preview: pv.duration,
      options: [15, 30, 60, 120].map((v) => ({ v, label: v + 'S' })) },
    { key: 'lives', label: 'LIVES', default: 3, when: (c) => c.end === 'lives', preview: pv.lives,
      options: [1, 3, 5, 10].map((v) => ({ v, label: String(v) })) },
  ];

  // ---------- crosshair (survev SVGs in js/crosshairs.js) ----------
  const SW = [['#000000', 'BLACK'], ['#FF6A00', 'ORANGE'], ['#FFFFFF', 'WHITE'], ['#FF0000', 'RED'],
    ['#00D000', 'GREEN'], ['#0066FF', 'BLUE'], ['#FF00FF', 'MAGENTA'], ['#00E5FF', 'CYAN'], ['#FFE600', 'YELLOW']]
    .map(([v, label]) => ({ v, label, swatch: v }));
  AT.XH_STYLE_DEFAULT = 'crosshair_010';
  AT.XH_SETTINGS = [
    { key: 'color', label: 'COLOR', default: '#000000', options: SW },
    { key: 'size', label: 'SIZE', type: 'range', default: 1, min: 0.5, max: 2, step: 0.05,
      format: (v) => v.toFixed(2) + 'X' },
    { key: 'outline', label: 'OUTLINE THICKNESS', type: 'range', default: 0.5, min: 0, max: 1.5, step: 0.05,
      format: (v) => (v === 0 ? 'NONE' : v.toFixed(2)) },
  ];

  // Survev crosshair as one SVG, used as a hardware CSS cursor (no render lag).
  // Browsers cap cursor images at 128px; size max 2x = 128px.
  AT.buildCursor = (x) => {
    const def = (AT.CROSSHAIRS || []).find((c) => c.id === x.style) || AT.CROSSHAIRS[0];
    let S = Math.min(128, Math.max(8, Math.round((64 * x.size) / 2) * 2));
    const c = S / 2;
    const inner = def.svg
      .replace(/white/g, x.color)
      .replace(/stroke-width="\.5"/g, `stroke-width="${x.outline}"`)
      .replace('width="64"', `width="${S}"`)
      .replace('height="64"', `height="${S}"`);
    const svg = inner;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    return { url, css: `url("${url}") ${c} ${c}, crosshair`, size: S };
  };
})();
