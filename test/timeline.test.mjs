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
