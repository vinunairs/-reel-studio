// Real-time playback of a timeline onto a canvas, with the mixed soundtrack.
// Used for preview, and for the fallback export (MediaRecorder records it live).
import { drawFrame } from './render.js';
import { visibleAt, sourceTimeAt } from './timeline.js';

let liveCtx = null;
export function audioContext() {
  if (!liveCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    liveCtx = new AC({ sampleRate: 48000 });
  }
  return liveCtx;
}

export class Player {
  constructor(canvas, tl, soundtrack, opts = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.tl = tl;
    this.soundtrack = soundtrack;
    this.opts = opts;
    this.playing = false;
    this.onTime = null;
    this.onEnd = null;
  }

  // extraDest: optional AudioNode (e.g. MediaStreamDestination) to also feed
  async play(from = 0, extraDest = null) {
    this.stop();
    const ac = audioContext();
    if (ac.state !== 'running') await ac.resume();
    // get every visible video near the start frame-ready before the clock starts
    await this._sync(from, true);
    this.t0 = ac.currentTime + 0.05 - from;
    if (this.soundtrack) {
      const src = ac.createBufferSource();
      src.buffer = this.soundtrack;
      src.connect(ac.destination);
      if (extraDest) src.connect(extraDest);
      src.start(this.t0 + from, from);
      this.src = src;
    }
    this.playing = true;
    const tick = () => {
      if (!this.playing) return;
      const t = ac.currentTime - this.t0;
      if (t >= this.tl.total) {
        drawFrame(this.ctx2d, this.tl, this.tl.total, this.opts);
        this.stop();
        this.onEnd && this.onEnd();
        return;
      }
      this._sync(t, false);
      drawFrame(this.ctx2d, this.tl, Math.max(0, t), this.opts);
      this.onTime && this.onTime(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  async _sync(t, wait) {
    const visible = new Set();
    const waits = [];
    for (const { entry } of visibleAt(this.tl.entries, t)) {
      if (entry.item.kind !== 'video') continue;
      const v = entry.item.el;
      visible.add(v);
      const want = sourceTimeAt(entry, t);
      if (v.paused || Math.abs(v.currentTime - want) > 0.25) {
        if (Math.abs(v.currentTime - want) > 0.08) v.currentTime = want;
        if (wait) waits.push(new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 1500); }));
        if (v.paused) v.play().catch(() => {});
      }
    }
    for (const e of this.tl.entries) {
      if (e.item.kind !== 'video') continue;
      const v = e.item.el;
      if (visible.has(v)) continue;
      if (!v.paused) v.pause();
      // cue up a clip that's about to come in, so it doesn't stutter on entry
      const first = e.pieces[0].srcStart;
      if (e.start > t && e.start - t < 0.8 && !v.seeking && Math.abs(v.currentTime - first) > 0.08) v.currentTime = first;
    }
    if (wait) await Promise.all(waits);
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    if (this.src) { try { this.src.stop(); } catch {} this.src = null; }
    for (const e of this.tl.entries) if (e.item.kind === 'video') e.item.el.pause();
  }
}
