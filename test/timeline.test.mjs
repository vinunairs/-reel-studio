import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKeepRanges, buildTimeline, sourceTimeAt, visibleAt, formatTime, XFADE } from '../js/timeline.js';

const words = [
  { text: 'Hi', start: 0.5, end: 0.8 },
  { text: 'everyone', start: 0.9, end: 1.4 },
  { text: 'um', start: 2.0, end: 2.3 },
  { text: 'welcome', start: 4.0, end: 4.5 },
  { text: 'home.', start: 4.6, end: 5.0 },
];

test('cuts long pauses and filler words', () => {
  const r = computeKeepRanges(words, 8);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].map(x => +x.toFixed(2)), [0.35, 1.55]);
  assert.deepEqual(r[1].map(x => +x.toFixed(2)), [3.85, 5.15]);
});

test('keeps the whole clip when nothing was heard', () => {
  assert.deepEqual(computeKeepRanges([], 6), [[0, 6]]);
  assert.deepEqual(computeKeepRanges([{ text: 'um', start: 1, end: 1.2 }], 6), [[0, 6]]);
});

test('photos crossfade and add up correctly', () => {
  const tl = buildTimeline([{ kind: 'photo', duration: 3 }, { kind: 'photo', duration: 3 }]);
  assert.equal(tl.entries[1].start, 3 - XFADE);
  assert.equal(+tl.total.toFixed(3), +(6 - XFADE).toFixed(3));
  const mid = visibleAt(tl.entries, 3 - XFADE / 2);
  assert.equal(mid.length, 2);
  assert.ok(Math.abs(mid[1].alpha - 0.5) < 1e-9);
});

test('trimmed video maps output time back to source time', () => {
  const tl = buildTimeline([{ kind: 'video', srcDuration: 8, trim: true, words }]);
  const e = tl.entries[0];
  assert.equal(e.pieces.length, 2);
  const firstLen = 1.55 - 0.35;
  assert.ok(Math.abs(tl.total - (firstLen + 1.3)) < 1e-6);
  assert.ok(Math.abs(sourceTimeAt(e, 0) - 0.35) < 1e-6);
  assert.ok(Math.abs(sourceTimeAt(e, firstLen + 0.1) - 3.95) < 1e-6);
});

test('captions follow the trimmed timeline', () => {
  const tl = buildTimeline([{ kind: 'video', srcDuration: 8, trim: true, captions: true, words }]);
  const allWords = tl.cues.flatMap(c => c.words.map(w => w.text));
  assert.deepEqual(allWords, ['Hi', 'everyone', 'welcome', 'home.']);
  const welcome = tl.cues.flatMap(c => c.words).find(w => w.text === 'welcome');
  assert.ok(Math.abs(welcome.start - (1.2 + 0.15)) < 1e-6);
});

test('caps the reel at 60 seconds', () => {
  const items = Array.from({ length: 30 }, () => ({ kind: 'photo', duration: 5 }));
  const tl = buildTimeline(items);
  assert.ok(tl.total <= 60 + 1e-9);
  assert.equal(tl.truncated, true);
});

test('long video is limited to 20 seconds per clip', () => {
  const tl = buildTimeline([{ kind: 'video', srcDuration: 120 }]);
  assert.equal(tl.total, 20);
  assert.equal(tl.truncated, true);
});

test('a too-short clip is skipped, not the rest of the reel', () => {
  const tl = buildTimeline([{ kind: 'photo', duration: 3 }, { kind: 'video', srcDuration: 0.25 }, { kind: 'photo', duration: 3 }, { kind: 'photo', duration: 3 }]);
  assert.equal(tl.entries.length, 3);
  assert.equal(tl.skipped, 1);
  assert.equal(tl.truncated, false);
});

test('unreadable duration and out-of-range word times do not empty the reel', () => {
  const tl = buildTimeline([{ kind: 'video', srcDuration: NaN }, { kind: 'video', srcDuration: 4, trim: true, words: [{ text: 'hi', start: 9, end: 9.5 }] }, { kind: 'photo', duration: 3 }]);
  assert.equal(tl.entries.length, 2);
  assert.ok(tl.total > 3);
});

test('a short clip is never covered by the next one', () => {
  const tl = buildTimeline([{ kind: 'photo', duration: 3 }, { kind: 'video', srcDuration: 0.5 }, { kind: 'photo', duration: 3 }]);
  const [a, b, c] = tl.entries;
  assert.ok(b.start >= a.start && c.start >= b.start + (b.end - b.start) / 2 - 1e-9);
  const mid = visibleAt(tl.entries, (b.start + b.end) / 2).find(v => v.entry === b);
  assert.ok(Math.abs(mid.alpha - 1) < 1e-9);
});

test('caption cues never end before they start', () => {
  const w = [{ text: 'one', start: 0.1, end: 0.5 }, { text: 'two', start: 1.6, end: 1.9 }];
  const tl = buildTimeline([{ kind: 'video', srcDuration: 2, captions: true, words: w }, { kind: 'video', srcDuration: 2, captions: true, words: w }]);
  for (const c of tl.cues) assert.ok(c.end >= c.start + 0.3 - 1e-9);
});

test('formatTime survives a missing duration', () => {
  assert.equal(formatTime(Infinity), '–:––');
  assert.equal(formatTime(65), '1:05');
});

// ---------- beats + templates ----------
import { detectBeats, fallbackBeats } from '../js/beats.js';
import { planTemplate, TEMPLATES } from '../js/timeline.js';

function clickTrack({ bpm, phase, seconds = 20, sr = 22050, accent = null }) {
  const x = new Float32Array(seconds * sr);
  const period = 60 / bpm;
  const click = (t, amp) => {
    const i0 = Math.round(t * sr);
    for (let k = 0; k < 600 && i0 + k < x.length; k++) x[i0 + k] += amp * Math.exp(-k / 120) * Math.sin(k * 0.9);
  };
  for (let t = phase; t < seconds; t += period) click(t, accent != null && Math.abs(t - accent) < 1e-6 ? 1 : 0.35);
  return { x, sr };
}
const onGrid = (t, b, unit = b.period) => { const k = (t - b.phase) / unit; return Math.abs(k - Math.round(k)) * unit < 0.01; };

test('finds tempo, phase and the drop in a click track', () => {
  const { x, sr } = clickTrack({ bpm: 120, phase: 0.25, accent: 3.25 });
  const b = detectBeats(x, sr);
  assert.ok(Math.abs(b.bpm - 120) <= 1, `bpm ${b.bpm}`);
  assert.ok(onGrid(0.25, b), `phase ${b.phase}`);
  assert.ok(Math.abs(b.drop - 3.25) < 0.03, `drop ${b.drop}`);
  assert.equal(b.confident, true);
});

test('kicks set the phase over off-beat hi-hats, and the loudness jump marks the drop', () => {
  const sr = 22050, secs = 14, bpm = 112, period = 60 / bpm, phase = 0.3, drop = phase + 7 * period;
  const x = new Float32Array(sr * secs);
  let seed = 1; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const add = (t, len, f) => { const i0 = Math.round(t * sr); for (let k = 0; k < len * sr && i0 + k < x.length; k++) x[i0 + k] += f(k / sr); };
  for (let t = phase; t < secs; t += period) {
    const amp = t < drop - 1e-6 ? 0.3 : 0.9;
    add(t, 0.25, u => amp * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-u * 30)) * u) * Math.exp(-u * 14));
    add(t + period / 2, 0.08, u => 0.25 * rnd() * Math.exp(-u * 60));
  }
  const b = detectBeats(x, sr);
  assert.ok(Math.abs(b.bpm - bpm) <= 1, `bpm ${b.bpm}`);
  assert.ok(onGrid(phase, b), `phase ${b.phase}`);
  assert.ok(Math.abs(b.drop - drop) < 0.03, `drop ${b.drop} want ${drop}`);
});

test('reads a 96 BPM track as 96, not double', () => {
  const { x, sr } = clickTrack({ bpm: 96, phase: 0.1 });
  const b = detectBeats(x, sr);
  assert.ok(Math.abs(b.bpm - 96) <= 1, `bpm ${b.bpm}`);
});

test('silence falls back to a steady 120 BPM grid', () => {
  const b = detectBeats(new Float32Array(22050 * 5), 22050);
  assert.deepEqual([b.bpm, b.period, b.confident], [120, 0.5, false]);
});

const photos = n => Array.from({ length: n }, () => ({ kind: 'photo', duration: 3 }));
const beats = { period: 60 / 128, phase: 0.11, drop: 0.11 + 7 * 60 / 128 };

test('Beat Drop: first photo holds until the drop, every cut lands on a beat', () => {
  const plan = planTemplate(photos(10), 'beatdrop', beats);
  const tl = buildTimeline(photos(10), { ...plan, template: 'beatdrop', beats });
  assert.ok(Math.abs(tl.entries[1].start - beats.drop) < 1e-6);
  for (const e of tl.entries.slice(1)) assert.ok(onGrid(e.start, beats), `cut at ${e.start}`);
  for (const e of tl.entries.slice(1, -1)) { const d = e.end - e.start; assert.ok(d >= 0.4 - 1e-9 && d <= 0.9 + 1e-9, `len ${d}`); }
});

test('Journey: each whip is centred on a beat', () => {
  const plan = planTemplate(photos(6), 'journey', beats);
  const tl = buildTimeline(photos(6), { ...plan, template: 'journey', beats });
  for (const e of tl.entries.slice(1)) {
    assert.ok(Math.abs(e.fadeIn - TEMPLATES.journey.xfade) < 1e-9);
    assert.ok(onGrid(e.start + e.fadeIn / 2, beats), `whip mid at ${e.start + e.fadeIn / 2}`);
  }
});

test('Cinematic: dissolves are centred on bar lines and photos stay 2.5–4.4 s', () => {
  const plan = planTemplate(photos(5), 'cinematic', beats);
  const tl = buildTimeline(photos(5), { ...plan, template: 'cinematic', beats });
  for (const e of tl.entries.slice(1)) assert.ok(onGrid(e.start + e.fadeIn / 2, beats, beats.period * 4), `dissolve at ${e.start}`);
  for (const b of plan.boundaries.slice(0, -1).map((x, i, a) => (i ? x - a[i - 1] : x))) assert.ok(b >= 2.5 - 1e-9 && b <= 4.4 + 1e-9, `gap ${b}`);
});

test('Photo Dump: quick beat cuts plus a closing grid that extends the reel', () => {
  const plan = planTemplate(photos(12), 'dump', beats);
  const tl = buildTimeline(photos(12), { ...plan, template: 'dump', beats });
  assert.ok(Math.abs(tl.total - tl.outroStart - TEMPLATES.dump.outro) < 1e-9);
  for (const e of tl.entries) { const d = e.end - e.start; assert.ok(d >= 0.5 - 1e-9 && d <= 1.0 + 1e-9, `len ${d}`); }
});

test('a clip shorter than a beat step plays whole, then cuts snap back onto the grid', () => {
  const items = [{ kind: 'photo' }, { kind: 'video', srcDuration: 0.8 }, { kind: 'photo' }, { kind: 'photo' }];
  const plan = planTemplate(items, 'journey', beats);
  const tl = buildTimeline(items, { ...plan, template: 'journey', beats });
  const clip = tl.entries[1];
  assert.ok(clip.end - clip.start <= 0.8 + 1e-9);
  const last = tl.entries[3];
  assert.ok(onGrid(last.start + last.fadeIn / 2, beats), `back on grid at ${last.start}`);
});

test('a clip never gets more screen time than it has footage', () => {
  const items = [{ kind: 'photo' }, { kind: 'video', srcDuration: 1.7 }, { kind: 'photo' }];
  const plan = planTemplate(items, 'cinematic', beats);
  assert.ok(plan.lengths[1] <= 1.7 + 1e-9, `got ${plan.lengths[1]}`);
});

test('Postcard keeps its own timing; no music still gives a beat plan', () => {
  assert.equal(planTemplate(photos(3), 'postcard', beats), null);
  const plan = planTemplate(photos(4), 'dump', fallbackBeats());
  assert.ok(plan.boundaries.every(b => onGrid(b, fallbackBeats())));
});

test('a planned reel still respects the 60 s cap', () => {
  const items = Array.from({ length: 40 }, () => ({ kind: 'photo' }));
  const plan = planTemplate(items, 'cinematic', beats);
  const tl = buildTimeline(items, { ...plan, template: 'cinematic', beats });
  assert.ok(tl.total <= 60 + 1e-9);
  assert.equal(tl.truncated, true);
  assert.equal(tl.skipped, 0);
});
