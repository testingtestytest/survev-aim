// Customizable keybinds (KeyboardEvent.code, up to 2 per action), stored in localStorage.
(function () {
  AT.BIND_ACTIONS = [
    { id: 'up', label: 'MOVE UP', def: ['KeyW', 'ArrowUp'] },
    { id: 'down', label: 'MOVE DOWN', def: ['KeyS', 'ArrowDown'] },
    { id: 'left', label: 'MOVE LEFT', def: ['KeyA', 'ArrowLeft'] },
    { id: 'right', label: 'MOVE RIGHT', def: ['KeyD', 'ArrowRight'] },
    { id: 'primary', label: 'PRIMARY', def: ['Digit1'] },
    { id: 'secondary', label: 'SECONDARY', def: ['Digit2'] },
    { id: 'melee', label: 'MELEE', def: ['Digit3', 'KeyE'] },
    { id: 'swap', label: 'SWAP WEAPONS', def: ['Space'] },
    { id: 'reload', label: 'RELOAD', def: ['KeyR'] },
  ];

  function load() {
    const saved = AT.store.get('binds', {}) || {};
    const b = {};
    AT.BIND_ACTIONS.forEach((a) => {
      const v = saved[a.id];
      b[a.id] = Array.isArray(v) ? v.slice(0, 2).map((x) => x || '') : a.def.slice();
      while (b[a.id].length < 2) b[a.id].push('');
    });
    return b;
  }
  AT.binds = load();
  // Options that aren't keys. They apply everywhere and live on the same screen.
  AT.prefs = { blood: AT.store.get('blood', 'on'), fps: AT.store.get('fps', 'on') };
  AT.setPref = (k, v) => { AT.prefs[k] = v; AT.store.set(k, v); };
  AT.saveBinds = () => AT.store.set('binds', AT.binds);
  AT.resetBinds = () => { AT.store.set('binds', null); AT.binds = load(); };

  AT.setBind = (action, idx, code) => {
    // a key can only do one thing: remove it from any other action first
    if (code) Object.keys(AT.binds).forEach((k) => { AT.binds[k] = AT.binds[k].map((c) => (c === code ? '' : c)); });
    AT.binds[action][idx] = code;
    AT.saveBinds();
  };
  AT.actionOf = (code) => Object.keys(AT.binds).find((k) => AT.binds[k].includes(code)) || null;
  AT.bindHeld = (action, keys) => AT.binds[action].some((c) => c && keys.has(c));
  AT.keyLabel = (code) => {
    if (!code) return '—';
    if (code === 'Space') return 'SPACE';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'NUM' + code.slice(6);
    const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    if (arrows[code]) return arrows[code];
    return code.replace(/(Left|Right)$/, ' $1').toUpperCase();
  };
  AT.bindLabel = (action) => AT.binds[action].filter(Boolean).map(AT.keyLabel).join(' / ') || '—';
})();
