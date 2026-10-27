'use strict';

// Small sound engine: every effect is synthesized with the Web Audio API,
// so there are no audio files to download.
window.Sound = (function () {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('domino-muted') === '1'; } catch (e) { /* ignore */ }

  function audio() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Browsers only allow sound after the user has interacted with the page.
  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => audio(), { once: true }));

  function tone(freq, start, dur, opts) {
    const o = opts || {};
    const ac = ctx;
    const t0 = ac.currentTime + start;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(o.vol || 0.2, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise(start, dur, opts) {
    const o = opts || {};
    const ac = ctx;
    const t0 = ac.currentTime + start;
    const buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const filter = ac.createBiquadFilter();
    filter.type = o.filter || 'bandpass';
    filter.frequency.setValueAtTime(o.freq || 2000, t0);
    if (o.sweepTo) filter.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + dur);
    filter.Q.value = o.q || 1;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(o.vol || 0.4, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(ac.destination);
    src.start(t0);
  }

  const effects = {
    // Tile slapped on the table
    clack() {
      noise(0, 0.06, { freq: 3200, q: 0.8, vol: 0.9 });
      tone(220, 0, 0.09, { type: 'triangle', vol: 0.35, slideTo: 110 });
      noise(0.05, 0.04, { freq: 2400, q: 1, vol: 0.3 });
    },
    // Tile pulled from the boneyard
    draw() {
      noise(0, 0.22, { freq: 600, sweepTo: 3000, q: 0.7, vol: 0.35 });
      tone(500, 0.12, 0.1, { vol: 0.12, slideTo: 800 });
    },
    // Shuffle at the start of a round
    shuffle() {
      for (let i = 0; i < 7; i++) noise(i * 0.07, 0.06, { freq: 2500 + Math.random() * 1500, vol: 0.35 });
    },
    turn() {
      tone(784, 0, 0.18, { vol: 0.18 });
      tone(1175, 0.13, 0.3, { vol: 0.18 });
    },
    pass() {
      tone(330, 0, 0.18, { type: 'square', vol: 0.06, slideTo: 220 });
    },
    error() {
      tone(180, 0, 0.12, { type: 'sawtooth', vol: 0.08 });
      tone(150, 0.12, 0.18, { type: 'sawtooth', vol: 0.08 });
    },
    join() {
      tone(523, 0, 0.12, { vol: 0.18, slideTo: 784 });
      tone(1047, 0.1, 0.15, { vol: 0.12 });
    },
    message() {
      tone(880, 0, 0.08, { vol: 0.14 });
      tone(1320, 0.07, 0.12, { vol: 0.12 });
    },
    pop() {
      tone(600, 0, 0.1, { vol: 0.16, slideTo: 1100 });
    },
    click() {
      tone(1000, 0, 0.04, { vol: 0.08 });
    },
    win() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.25, { type: 'triangle', vol: 0.22 }));
      [784, 1047, 1319].forEach((f) => tone(f, 0.5, 0.7, { type: 'triangle', vol: 0.12 }));
    },
    lose() {
      [523, 494, 466, 392].forEach((f, i) => tone(f, i * 0.2, 0.3, { type: 'triangle', vol: 0.16 }));
    },
  };

  return {
    play(name) {
      if (muted || !effects[name] || !audio()) return;
      try { effects[name](); } catch (e) { /* audio errors are never fatal */ }
    },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('domino-muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
      return muted;
    },
    get muted() { return muted; },
  };
})();
