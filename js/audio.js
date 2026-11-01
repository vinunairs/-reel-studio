// Mixes the soundtrack offline: music (looped, faded, lowered under talking clips)
// plus each video clip's own audio, cut to match the timeline.

export const RATE = 48000;
const MAX_DECODE_BYTES = 250 * 1024 * 1024; // bigger files are skipped to protect iPhone memory

let decodeCtx = null;
function getDecodeCtx() {
  if (!decodeCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    decodeCtx = new AC({ sampleRate: RATE });
  }
  return decodeCtx;
}

// Decode the audio track of a file. Returns null when there is none or it can't be read.
// One decode at a time (several big clips at once can get the tab killed on iPhone),
// and only the first maxSeconds are kept.
let queue = Promise.resolve();
export function decodeFile(file, maxSeconds = Infinity) {
  const job = queue.then(() => decodeNow(file, maxSeconds));
  queue = job.catch(() => {});
  return job;
}

async function decodeNow(file, maxSeconds) {
  if (!file || file.size > MAX_DECODE_BYTES) return null;
  try {
    let buf = await file.arrayBuffer();
    const full = await getDecodeCtx().decodeAudioData(buf);
    buf = null;
    if (full.duration <= maxSeconds + 0.5) return full;
    const len = Math.round(maxSeconds * full.sampleRate);
    const cut = new AudioBuffer({ length: len, numberOfChannels: full.numberOfChannels, sampleRate: full.sampleRate });
    for (let c = 0; c < full.numberOfChannels; c++) cut.copyToChannel(full.getChannelData(c).subarray(0, len), c);
    return cut;
  } catch {
    return null;
  }
}

// 16 kHz mono copy for speech recognition.
export async function toMono16k(buffer) {
  const len = Math.ceil(buffer.duration * 16000);
  const off = new OfflineAudioContext(1, Math.max(1, len), 16000);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

export function clipHasSound(item) {
  return item.kind === 'video' && !!item.audio && item.keepSound !== false;
}

// opts: { music: AudioBuffer|null, musicVolume: 0..1, duck: bool }
// Returns an AudioBuffer, or null when the reel has no sound at all.
export async function mixSoundtrack(tl, opts = {}) {
  const total = tl.total;
  const anyClip = tl.entries.some(e => clipHasSound(e.item));
  if (!total || (!opts.music && !anyClip)) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * RATE), RATE);
  const last = tl.entries.length - 1;

  for (const entry of tl.entries) {
    const { item } = entry;
    if (!clipHasSound(item)) continue;
    const entryGain = ctx.createGain();
    entryGain.connect(ctx.destination);
    const g = entryGain.gain;
    const fadeIn = entry.fadeIn ?? 0;
    const fadeOut = entry.index < last ? (tl.entries[entry.index + 1].fadeIn ?? 0) : 0;
    g.setValueAtTime(fadeIn > 0 ? 0 : 1, entry.start);
    if (fadeIn > 0) g.linearRampToValueAtTime(1, entry.start + fadeIn);
    if (fadeOut > 0) {
      g.setValueAtTime(1, Math.max(entry.start + fadeIn, entry.end - fadeOut));
      g.linearRampToValueAtTime(0, entry.end);
    }
    for (const p of entry.pieces) {
      const len = p.srcEnd - p.srcStart;
      if (len <= 0.02) continue;
      const src = ctx.createBufferSource();
      src.buffer = item.audio;
      const pg = ctx.createGain();
      // 15 ms fades at every cut so jump-cuts don't click
      pg.gain.setValueAtTime(0, p.outStart);
      pg.gain.linearRampToValueAtTime(1, p.outStart + 0.015);
      pg.gain.setValueAtTime(1, p.outStart + len - 0.015);
      pg.gain.linearRampToValueAtTime(0, p.outStart + len);
      src.connect(pg).connect(entryGain);
      src.start(p.outStart, p.srcStart, len);
    }
  }

  if (opts.music) {
    const vol = opts.musicVolume ?? 0.8;
    const low = vol * 0.22;
    let endLevel = vol;
    const mg = ctx.createGain();
    mg.connect(ctx.destination);
    const g = mg.gain;
    g.setValueAtTime(0, 0);
    g.linearRampToValueAtTime(vol, 0.5);
    if (opts.duck !== false) {
      // merge talking stretches that touch, so automation events stay in order
      const spans = [];
      for (const e of tl.entries) {
        if (!clipHasSound(e.item)) continue;
        const prev = spans[spans.length - 1];
        if (prev && e.start - prev[1] < 0.8) prev[1] = Math.max(prev[1], e.end);
        else spans.push([e.start, e.end]);
      }
      for (const [s, e] of spans) {
        const a = Math.max(0, s);
        if (e - a < 0.3) continue;
        g.cancelScheduledValues(a);
        g.setValueAtTime(a < 0.5 ? 0 : vol, a);
        g.linearRampToValueAtTime(low, Math.min(a + 0.3, e));
        if (e >= total - 1.5) { endLevel = low; break; } // still talking at the end: stay low, then fade out
        g.setValueAtTime(low, Math.max(a + 0.3, e - 0.3));
        g.linearRampToValueAtTime(vol, e);
      }
    }
    const fadeStart = Math.max(0.5, total - 1.5);
    g.setValueAtTime(endLevel, fadeStart);
    g.linearRampToValueAtTime(0, total);
    // loop the track if it's shorter than the reel
    const src = ctx.createBufferSource();
    src.buffer = opts.music;
    src.loop = opts.music.duration < total;
    src.connect(mg);
    src.start(0);
  }
  return ctx.startRendering();
}
