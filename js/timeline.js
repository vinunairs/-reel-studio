// Pure timeline logic: no DOM. Unit-tested in test/timeline.test.mjs.

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
export const MAX_TOTAL = 60;      // seconds of output, v1 cap
export const XFADE = 0.4;         // crossfade between items, seconds
export const MAX_VIDEO_CLIP = 20; // longest stretch taken from one video

const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'erm', 'er', 'ah', 'hmm', 'mm']);

export function cleanWord(text) {
  return String(text || '').toLowerCase().replace(/[^a-z']/g, '');
}

// From word timestamps, the parts of a clip worth keeping: speech, minus filler
// words, with long pauses removed. Returns [[start, end], ...] in source seconds.
export function computeKeepRanges(words, duration, opts = {}) {
  const gap = opts.gap ?? 0.6;   // pauses longer than this get cut
  const pad = opts.pad ?? 0.15;  // breathing room kept around speech
  const spoken = (words || []).filter(w =>
    Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start &&
    cleanWord(w.text) && !FILLERS.has(cleanWord(w.text)));
  if (!spoken.length) return [[0, duration]];
  const ranges = [];
  for (const w of spoken) {
    const s = Math.max(0, w.start - pad);
    const e = Math.min(duration, w.end + pad);
    const last = ranges[ranges.length - 1];
    if (last && s - last[1] <= gap) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  return ranges.filter(r => r[1] - r[0] >= 0.2);
}

// items: [{ id, kind: 'photo'|'video', duration (photo seconds), srcDuration (video),
//           trim, captions, words, hasAudio }]
// Returns { entries, total, truncated, cues }.
// entry: { item, index, start, end, pieces: [{ srcStart, srcEnd, outStart }] }
export function buildTimeline(items, opts = {}) {
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const xf = opts.xfade ?? XFADE;
  const entries = [];
  let cursor = 0;
  let truncated = false;

  for (const item of items) {
    const start = entries.length ? Math.max(0, cursor - xf) : 0;
    if (start >= maxTotal - 0.5) { truncated = true; break; }
    let pieces = [];
    if (item.kind === 'photo') {
      const d = item.duration || 3;
      pieces = [{ srcStart: 0, srcEnd: d, outStart: start }];
    } else {
      const srcDur = Math.max(0.1, item.srcDuration || 0);
      let ranges = item.trim && item.words ? computeKeepRanges(item.words, srcDur) : [[0, srcDur]];
      let budget = Math.min(MAX_VIDEO_CLIP, maxTotal - start);
      let out = start;
      for (const [s, e] of ranges) {
        if (budget <= 0.05) { truncated = true; break; }
        const len = Math.min(e - s, budget);
        if (len < e - s) truncated = true;
        pieces.push({ srcStart: s, srcEnd: s + len, outStart: out });
        out += len;
        budget -= len;
      }
    }
    let end = pieces.length ? pieces[pieces.length - 1].outStart + (pieces[pieces.length - 1].srcEnd - pieces[pieces.length - 1].srcStart) : start;
    if (end > maxTotal) {
      truncated = true;
      const p = pieces[pieces.length - 1];
      p.srcEnd -= end - maxTotal;
      end = maxTotal;
    }
    if (end - start < 0.3) { truncated = true; break; }
    entries.push({ item, index: entries.length, start, end, pieces });
    cursor = end;
  }
  const total = entries.length ? entries[entries.length - 1].end : 0;
  return { entries, total, truncated, cues: buildCues(entries) };
}

// Source time inside an entry for an output time, or null if out of range.
export function sourceTimeAt(entry, t) {
  if (t < entry.start || t > entry.end) return null;
  for (const p of entry.pieces) {
    const len = p.srcEnd - p.srcStart;
    if (t >= p.outStart && t <= p.outStart + len + 1e-6) return p.srcStart + (t - p.outStart);
  }
  const last = entry.pieces[entry.pieces.length - 1];
  return last ? last.srcEnd : 0;
}

function outTimeOf(entry, src) {
  for (const p of entry.pieces) {
    if (src >= p.srcStart && src <= p.srcEnd) return p.outStart + (src - p.srcStart);
  }
  return null;
}

// Caption cues in output time: short lines of a few words each.
export function buildCues(entries) {
  const cues = [];
  for (const entry of entries) {
    const { item } = entry;
    if (item.kind !== 'video' || !item.captions || !item.words) continue;
    let line = null;
    const flush = () => { if (line && line.words.length) cues.push(line); line = null; };
    for (const w of item.words) {
      const text = String(w.text || '').trim();
      if (!text || FILLERS.has(cleanWord(text))) continue;
      const s = outTimeOf(entry, w.start);
      const e = outTimeOf(entry, w.end);
      if (s == null || e == null) { flush(); continue; }
      const word = { text, start: s, end: Math.max(e, s + 0.05) };
      const chars = line ? line.words.map(x => x.text).join(' ').length + text.length + 1 : 0;
      if (!line || line.words.length >= 4 || chars > 24 || s - line.end > 0.8 || /[.?!]$/.test(line.words[line.words.length - 1].text)) {
        flush();
        line = { start: s, end: word.end, words: [word] };
      } else {
        line.words.push(word);
        line.end = word.end;
      }
    }
    flush();
  }
  // keep each cue on screen until the next starts (if close), so text doesn't flicker
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    cues[i].end = next && next.start - cues[i].end < 0.5 ? next.start : cues[i].end + 0.3;
  }
  return cues;
}

// Which entries are visible at time t, with their opacity (crossfades).
export function visibleAt(entries, t, xf = XFADE) {
  const out = [];
  for (const e of entries) {
    if (t < e.start || t > e.end) continue;
    let alpha = 1;
    if (e.index > 0 && t < e.start + xf) alpha = (t - e.start) / xf;
    out.push({ entry: e, alpha: Math.max(0, Math.min(1, alpha)) });
  }
  return out;
}

export function formatTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
