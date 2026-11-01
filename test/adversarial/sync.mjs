import { open, addFiles, exportAndSave, probe, root } from './harness.mjs';
import { execFileSync } from 'node:child_process';
const force = process.argv[2];
const words = () => { window.__transcribe = async () => [
  { text: 'alpha', start: 0.4, end: 0.7 }, { text: 'bravo', start: 1.4, end: 1.7 },
  { text: 'charlie', start: 4.4, end: 4.7 }, { text: 'delta', start: 5.4, end: 5.7 }]; };
const { page, errors, close } = await open({ force, opus: true, init: [words] });
try {
  await addFiles(page, ['sync.mp4', 'sync.mp4', 'photo1.jpg'], 3);
  await page.waitForFunction(() => window.__app.state.items.slice(0, 2).every(i => i.audio !== undefined));
  await page.click('#items li:nth-child(1) >> text=Cut pauses');
  await page.waitForFunction(() => !!window.__app.state.items[0].words && window.__app.state.tl.entries[0].pieces.length === 2);
  const tl = await page.evaluate(() => window.__app.state.tl.entries.map(e => ({ s: +e.start.toFixed(3), e: +e.end.toFixed(3), p: e.pieces.map(p => [+p.srcStart.toFixed(2), +p.srcEnd.toFixed(2), +p.outStart.toFixed(2)]) })));
  console.log('timeline', JSON.stringify(tl));
  const out = `${root}/test/out/sync-${force || 'webcodecs'}.mp4`;
  const info = await exportAndSave(page, out);
  const p = probe(out);
  console.log('method', info.method, 'total', info.total.toFixed(3), 'dur', p.dur, 'vdur', p.vdur, 'adur', p.adur, 'video start_time', p.v.start_time, 'audio start_time', p.a && p.a.start_time);
  console.log(execFileSync('python3', [`${root}/test/adversarial/sync_analyze.py`, out]).toString());
  console.log('errors', JSON.stringify(errors));
} finally { await close(); }
