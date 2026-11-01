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
  const lengths = opts.lengths || null; // per-item on-screen length from planTemplate()
  const entries = [];
  let cursor = 0;
  let truncated = false;

  let skipped = 0;
  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    const planned = lengths ? lengths[n] : null;
    if (planned === 0) { skipped++; continue; } // planner found nothing usable in this item
    // crossfade can't be longer than half of either neighbour
    const prev = entries[entries.length - 1];
    const photoLen = planned ?? (item.duration || 3);
    const ownLen = item.kind === 'photo' ? photoLen : Math.min(item.srcDuration || 0, planned ?? Infinity);
    const fade = prev ? Math.max(0, Math.min(xf, (prev.end - prev.start) / 2, ownLen / 2)) : 0;
    const start = prev ? Math.max(0, cursor - fade) : 0;
    if (start >= maxTotal - 0.5) { truncated = true; break; }
    let pieces = [];
    if (item.kind === 'photo') {
      const d = photoLen;
      pieces = [{ srcStart: 0, srcEnd: d, outStart: start }];
    } else {
      const srcDur = Number.isFinite(item.srcDuration) ? item.srcDuration : 0;
      let ranges = item.trim && item.words ? computeKeepRanges(item.words, srcDur) : [[0, srcDur]];
      ranges = ranges.map(([a, b]) => [Math.max(0, a), Math.min(srcDur, b)]).filter(([a, b]) => b - a > 0.05);
      if (!ranges.length && srcDur > 0.05) ranges = [[0, srcDur]]; // speech times made no sense: keep the clip whole
      let budget = Math.min(MAX_VIDEO_CLIP, maxTotal - start, planned ?? Infinity);
      let out = start;
      for (const [s, e] of ranges) {
        if (budget <= 0.05) { if (planned == null) truncated = true; break; }
        const len = Math.min(e - s, budget);
        if (len < e - s && planned == null) truncated = true;
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
    // too short or unreadable: leave this one out, keep going with the rest
    if (end - start < 0.3) { skipped++; continue; }
    entries.push({ item, index: entries.length, start, end, pieces, fadeIn: fade });
    cursor = end;
  }
  const last = entries.length ? entries[entries.length - 1].end : 0;
  const outro = entries.length ? Math.max(0, Math.min(opts.outro || 0, maxTotal - last)) : 0;
  const total = last + outro;
  return {
    entries, total, truncated, skipped, cues: buildCues(entries),
    template: opts.template || 'postcard', beats: opts.beats || null, outroStart: last,
  };
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
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const end = next && next.start - cues[i].end < 0.5 ? next.start : cues[i].end + 0.3;
    cues[i].end = Math.max(end, cues[i].start + 0.3);
  }
  return cues;
}

// Which entries are visible at time t, with their opacity (crossfades).
export function visibleAt(entries, t, xf = XFADE) {
  const out = [];
  for (const e of entries) {
    if (t < e.start || t > e.end) continue;
    let alpha = 1;
    const fade = e.fadeIn ?? (e.index > 0 ? xf : 0);
    if (fade > 0 && t < e.start + fade) alpha = (t - e.start) / fade;
    out.push({ entry: e, alpha: Math.max(0, Math.min(1, alpha)) });
  }
  return out;
}

export function formatTime(s) {
  if (!Number.isFinite(s)) return '–:––';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- templates ----------
// Timing rules come from studying popular reels (Nov 2026): cuts land on the beat
// (usually within 0.03 s), photo runs use 0.4–0.7 s per photo, the reveal/drop comes
// 2.4–4.1 s in, and slower "memory" edits change on bar lines.
//   unitBeats: grid step in beats (Cinematic changes on bars)
//   photo / video: [min, target, max] seconds between transitions
//   xfade: transition length; its midpoint lands on the beat
export const TEMPLATES = {
  postcard: { label: 'Postcard', beat: false },
  beatdrop: { label: 'Beat Drop', beat: true, unitBeats: 1, photo: [0.4, 0.5, 0.9], video: [1.5, 2.2, 3.2], xfade: 0, intro: true },
  dump: { label: 'Photo Dump', beat: true, unitBeats: 1, photo: [0.5, 0.65, 1.0], video: [2, 3, 4], xfade: 0, outro: 2.4 },
  journey: { label: 'Journey', beat: true, unitBeats: 1, photo: [1.4, 2, 2.6], video: [2, 4, 6], xfade: 0.3 },
  cinematic: { label: 'Cinematic Memory', beat: true, unitBeats: 4, photo: [2.5, 3.2, 4.4], video: [3, 5, 8], xfade: 0.8 },
};

// Seconds of usable footage in a clip (after pause trimming), capped like buildTimeline.
export function usableLength(item) {
  if (item.kind === 'photo') return Infinity;
  const src = Number.isFinite(item.srcDuration) ? item.srcDuration : 0;
  let len = src;
  if (item.trim && item.words) {
    const r = computeKeepRanges(item.words, src).map(([a, b]) => [Math.max(0, a), Math.min(src, b)]).filter(([a, b]) => b - a > 0.05);
    if (r.length) len = r.reduce((s, [a, b]) => s + b - a, 0);
  }
  return Math.min(len, MAX_VIDEO_CLIP);
}

// Picks an on-screen length for every item so each transition's midpoint lands on a
// beat of the track. beats: { period, phase, drop } (see beats.js).
// Returns { lengths, xfade, outro, boundaries } — lengths feed buildTimeline().
export function planTemplate(items, templateId, beats, opts = {}) {
  const T = TEMPLATES[templateId];
  if (!T || !T.beat) return null;
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const period = beats && beats.period > 0.15 ? beats.period : 0.5;
  const phase = beats && Number.isFinite(beats.phase) ? beats.phase : 0;
  const f = T.xfade;
  let unit = period * T.unitBeats;
  if (T.unitBeats > 1 && unit > T.photo[2]) unit = period * Math.max(1, T.unitBeats / 2);
  const grid = k => phase + k * unit;
  const firstK = t => Math.ceil((t - phase) / unit - 1e-9); // first grid index at or after t

  const lengths = [];
  const boundaries = [];
  let B = 0;        // current transition time (start of the reel for the first item)
  let first = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const avail = usableLength(item);
    if (avail < 0.3) { lengths.push(0); continue; }
    const [mn, target, mx] = item.kind === 'photo' ? T.photo : T.video;
    const head = first ? 0 : f / 2;   // part of this item shown before its boundary B
    const tail = f / 2;               // part shown after the next boundary
    let next = null;
    if (first && T.intro && beats && Number.isFinite(beats.drop) && beats.drop + tail <= avail) {
      next = beats.drop; // Beat Drop: the first item is the teaser, held until the drop
    } else {
      let best = null;
      for (let k = firstK(B + mn); grid(k) - B <= mx + 1e-9; k++) {
        const g = grid(k);
        if (g - B + head + tail > avail + 1e-9) break;
        if (best == null || Math.abs(g - B - target) < Math.abs(best - B - target)) best = g;
      }
      if (best == null) {
        // nothing in range: the nearest grid point after the minimum that still fits,
        // else (a short clip) its own length, and the next item snaps back onto the grid
        const g = grid(firstK(B + Math.min(mn, Math.max(unit, 0.3))));
        best = g - B + head + tail <= avail + 1e-9 ? g : B + avail - head - tail;
      }
      next = best;
    }
    lengths.push(next - B + head + tail);
    boundaries.push(next);
    B = next;
    first = false;
    if (B >= maxTotal) break;
  }
  while (lengths.length < items.length) lengths.push(null); // past the cap: buildTimeline truncates
  // the last item has no transition after it: it ends on its boundary
  const lastIdx = lengths.map((l, i) => (l > 0 ? i : -1)).filter(i => i >= 0).pop();
  if (lastIdx != null && lengths[lastIdx] > f / 2) lengths[lastIdx] -= f / 2;
  return { lengths, xfade: f, outro: T.outro || 0, boundaries };
}
