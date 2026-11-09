// The game's sound effects, played by the rules of client/src/audioManager.ts and client/src/lib/createJS.ts.
// The sim says what happened and where; this decides how loud it is from your position and which ear it's in.
(function () {
  const S = SV.SOUND;
  const BASE_VOLUME = 0.5;          // audioManager.baseVolume
  const MIN_VOLUME = 0.003;         // AudioManagerMinAllowedVolume: anything quieter isn't played
  const COALESCE_TIME = 0.03;       // createJS kCoalesceTime
  const ALWAYS = ['gun_switch_01', 'footstep_grass', 'player_bullet_hit', 'bullet_whiz',
    SV.FRAG.explosion.sound, SV.FRAG.ground, ...Object.values(SV.FRAG.sound), ...Object.values(SV.ITEMS).map((i) => i.sound),
    ...Object.values(SV.OBSTACLE_DEFS).flatMap((o) => [o.sound.bullet, o.sound.punch, o.sound.explode])];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let ctx = null, out = null, gotCtx = null, roll = 1;
  const whenCtx = new Promise((r) => { gotCtx = r; });
  const buffers = {}, loading = {}, playing = {};

  // Browsers only allow sound after the player has done something on the page.
  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && AC) {
      ctx = new AC();
      out = ctx.createGain();
      out.gain.value = AT.prefs.volume / 100;
      out.connect(ctx.destination);
      gotCtx();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  ['pointerdown', 'touchend', 'keydown', 'click'].forEach((e) => addEventListener(e, unlock, true));

  // Decoding happens off the main thread. A sound that isn't ready yet is skipped, as in the game.
  function load(name) {
    if (loading[name] || !S.files[name]) return;
    loading[name] = true;
    fetch('assets/' + S.files[name].path)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((data) => whenCtx.then(() => ctx.decodeAudioData(data)))
      .then((b) => { buffers[name] = b; })
      .catch(() => { loading[name] = false; });   // tried again next round
  }
  function prepare(names) {
    names.forEach((n) => {
      if (S.groups[n]) S.groups[n].sounds.forEach(load);
      else if (n) load(n);
    });
  }

  function finish(inst) {
    const list = playing[inst.name], at = list ? list.indexOf(inst) : -1;
    if (at < 0) return;
    list.splice(at, 1);
    inst.src.onended = null;
    try { inst.src.stop(); } catch (e) { /* already ended */ }
    inst.src.disconnect();
    inst.gain.disconnect();
    if (inst.panner) inst.panner.disconnect();
  }

  const Audio = {
    me: null,                       // the player whose ears these are
    prepare,
    // Loads what this round can play and listens from this player.
    begin(me, weapons) {
      Audio.me = me;
      prepare(ALWAYS);
      weapons.map(SV.defOf).filter(Boolean).forEach((d) => prepare(Object.values(d.sound).filter((n) => typeof n === 'string')));
      return Audio;
    },
    // audioManager.playSound. Returns something to stop it with, or null if nothing started.
    play(name, channel, pos, fallOff = 0, rangeMult = 1) {
      const buf = buffers[name], ch = S.channels[channel];
      if (!buf || !ctx || ctx.state !== 'running' || AT.prefs.volume <= 0) return null;
      let volume = ch.volume * BASE_VOLUME, pan = 0;
      if (channel !== 'activePlayer' && pos && Audio.me) {
        const dx = Audio.me.pos.x - pos.x, dy = Audio.me.pos.y - pos.y;
        const range = ch.maxRange * rangeMult;
        volume *= (1 - clamp(Math.hypot(dx, dy) / range, 0, 1)) ** (1 + fallOff * 2);
        if (volume <= MIN_VOLUME) return null;
        pan = clamp(-dx / range, -1, 1);
      }
      const file = S.files[name];
      volume *= file.volume;
      const list = playing[name] || (playing[name] = []);
      const stopTime = ctx.currentTime + buf.duration;
      // createJS: a sound starting right with another copy of itself, like shotgun pellets landing, adds to it
      if (file.coalesce) {
        for (const q of list) {
          if (Math.abs(stopTime - q.stopTime) > COALESCE_TIME) continue;
          const v = q.volume + volume;
          q.pan = (q.volume * q.pan + volume * pan) / Math.max(0.001, v);
          q.volume = Math.sqrt(q.volume * q.volume + volume * volume);
          q.gain.gain.value = q.volume;
          if (q.panner) q.panner.pan.value = q.pan;
          return null;
        }
      }
      // createJS: at this sound's limit, the oldest copy stops
      while (list.length >= file.max) {
        finish(list.reduce((a, b) => (b.stopTime < a.stopTime ? b : a)));
      }
      const inst = { name, stopTime, volume, pan, src: ctx.createBufferSource(), gain: ctx.createGain(), panner: ctx.createStereoPanner ? ctx.createStereoPanner() : null };
      inst.src.buffer = buf;
      inst.gain.gain.value = volume;
      inst.src.connect(inst.gain);
      if (inst.panner) { inst.panner.pan.value = pan; inst.gain.connect(inst.panner); inst.panner.connect(out); }
      else inst.gain.connect(out);
      inst.src.onended = () => finish(inst);
      inst.src.start();
      list.push(inst);
      return inst;
    },
    // audioManager.playGroup. Group picks use their own numbers so sound can't change the round's random events.
    group(name, pos, fallOff = 0) {
      const g = S.groups[name];
      if (!g) return null;
      roll = (roll * 1103515245 + 12345) & 0x7fffffff;
      return Audio.play(g.sounds[(roll >> 16) % g.sounds.length], g.channel, pos, fallOff);
    },
    stop(inst) { if (inst) finish(inst); },
    stopAll() { Object.values(playing).forEach((list) => list.slice().forEach(finish)); },
    setVolume() { if (out) out.gain.value = AT.prefs.volume / 100; },
  };
  SV.Audio = Audio;
})();
