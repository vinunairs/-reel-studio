import { open } from './harness.mjs';
const { page, errors, close } = await open();
try {
  const res = await page.evaluate(async () => {
    const { mixSoundtrack } = await import('/js/audio.js');
    const { buildTimeline } = await import('/js/timeline.js');
    const thrown = [];
    for (const m of ['setValueAtTime', 'linearRampToValueAtTime']) {
      const f = AudioParam.prototype[m];
      AudioParam.prototype[m] = function (...a) { try { return f.apply(this, a); } catch (e) { thrown.push(`${m}(${a.map(x => +(+x).toFixed(3))}): ${e.message}`); throw e; } };
    }
    const dc = (sec, v) => { const b = new AudioBuffer({ length: Math.max(1, Math.round(sec * 48000)), numberOfChannels: 2, sampleRate: 48000 }); b.getChannelData(0).fill(v); b.getChannelData(1).fill(v); return b; };
    const P = d => ({ kind: 'photo', duration: d });
    const V = (d, audioVal = 1) => ({ kind: 'video', srcDuration: d, audio: dc(d, audioVal), keepSound: true });
    const at = (buf, t) => buf ? +buf.getChannelData(0)[Math.min(buf.length - 1, Math.round(t * 48000))].toFixed(3) : null;
    const cases = {
      adjacentTalking: [V(4, 0), V(4, 0), P(3)],
      talkingLast: [P(3), V(4, 0)],
      shortReel: [V(1.5, 0)],
      tinyReel: [V(0.4, 0)],
      musicLonger: [P(2), V(3, 0)],
      shortClipsNonMonotonic: [P(3), V(0.35, 0), V(0.35, 0), P(3)],
    };
    const out = {};
    for (const [name, items] of Object.entries(cases)) {
      const tl = buildTimeline(items);
      try {
        // music = DC 1.0, clip audio silent => output is the music gain curve
        const musicLen = name === 'musicLonger' ? 30 : 1.0; // short music forces looping
        const b = await mixSoundtrack(tl, { music: dc(musicLen, 1), musicVolume: 0.8, duck: true });
        const T = tl.total;
        const samples = [0.25, 0.6, T / 2, T - 1.6, T - 0.75, T - 0.01].filter(t => t >= 0 && t < T).map(t => [+t.toFixed(2), at(b, t)]);
        let nonFinite = 0, maxAbs = 0; const d = b.getChannelData(0); for (const x of d) { if (!Number.isFinite(x)) nonFinite++; maxAbs = Math.max(maxAbs, Math.abs(x)); }
        out[name] = { total: +T.toFixed(2), spans: tl.entries.map(e => [+e.start.toFixed(2), +e.end.toFixed(2)]), musicGain: samples, nonFinite, maxAbs: +maxAbs.toFixed(3) };
      } catch (e) { out[name] = 'THREW ' + e.message; }
    }
    // clip-gain continuity across crossfade between two talking clips (music off, clip DC 1)
    const tl2 = buildTimeline([V(3, 1), V(3, 1)]);
    const b2 = await mixSoundtrack(tl2, {});
    out.crossfadeSum = [2.5, 2.7, 2.8, 2.9, 3.0].map(t => [t, at(b2, t)]);
    // trimmed clip: jump-cut gain shape (should be 1 except 15 ms around the cut)
    const tl3 = buildTimeline([{ ...V(8, 1), trim: true, words: [{ text: 'a', start: 0.5, end: 1.0 }, { text: 'b', start: 4, end: 4.5 }] }]);
    const b3 = await mixSoundtrack(tl3, {});
    out.jumpCut = { pieces: tl3.entries[0].pieces.map(p => [+p.srcStart.toFixed(2), +p.srcEnd.toFixed(2), +p.outStart.toFixed(2)]), gains: [0.3, 0.79, 0.8, 0.81, 1.2].map(t => [t, at(b3, t)]) };
    return { out, thrown };
  });
  console.log(JSON.stringify(res, null, 1));
  console.log('errors', JSON.stringify(errors));
} finally { await close(); }
