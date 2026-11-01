// End-to-end for the beat templates: same media + a 112 BPM track, exported in every
// style. Checks the beat detection, that cuts land on the beat in the actual MP4,
// durations, and writes a contact sheet (test/out/templates.png) to look at.
// Usage: NODE_PATH=$(npm root -g) node test/templates.e2e.mjs [--force=realtime]
import { open, addFiles, exportAndSave, probe, execFileSync, spawnSync, root } from './adversarial/harness.mjs';
import { mkdirSync } from 'node:fs';

const out = `${root}/test/out`;
mkdirSync(out, { recursive: true });
const force = (process.argv.find(a => a.startsWith('--force=')) || '').split('=')[1];
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

const TRACK = { bpm: 112, phase: 0.3, drop: 0.3 + 7 * 60 / 112 };
const places = ['Kochi', 'Munnar, Kerala', 'Munnar, Kerala', 'Thekkady', 'Alleppey', 'Alleppey'];
const { page, errors, close } = await open({ opus: true, force });
try {
  await addFiles(page, ['scene-party.jpg', 'scene-hills.jpg', 'scene-beach.jpg', 'clip.mp4', 'scene-city.jpg', 'scene-temple.jpg'], 6);
  await page.fill('#title', 'Kerala trip');
  await page.fill('#subtitle', 'Thrissur · Aug 2026');
  await page.setInputFiles('#music', `${root}/test/fixtures/beat112.mp3`);
  await page.waitForFunction(() => window.__app.state.music && window.__app.state.music.beats, null, { timeout: 20000 });
  const beats = await page.evaluate(() => window.__app.state.music.beats);
  console.log('beats', beats);
  check(Math.abs(beats.bpm - TRACK.bpm) <= 1, `tempo ${beats.bpm} ≈ ${TRACK.bpm}`);
  const k = (beats.phase - TRACK.phase) / beats.period;
  check(Math.abs(k - Math.round(k)) * beats.period < 0.04, `beat phase ${beats.phase.toFixed(3)} on the kick`);
  check(Math.abs(beats.drop - TRACK.drop) < 0.04, `drop ${beats.drop.toFixed(3)} ≈ ${TRACK.drop.toFixed(3)}`);
  await page.waitForFunction(() => window.__app.state.items[3].audio !== undefined, null, { timeout: 10000 });

  const sheet = [];
  for (const [id, label] of [['beatdrop', 'Beat Drop'], ['dump', 'Photo Dump'], ['journey', 'Journey'], ['cinematic', 'Cinematic Memory']]) {
    await page.click(`#styles >> text="${label}"`);
    if (id === 'journey' || id === 'dump') {
      for (let i = 0; i < places.length; i++) {
        const input = page.locator(`#items li:nth-child(${i + 1}) input.place`);
        await input.fill(places[i]);
      }
    }
    const tl = await page.evaluate(() => {
      const t = window.__app.state.tl;
      return { template: t.template, total: t.total, outroStart: t.outroStart,
        cuts: t.entries.slice(1).map(e => e.start + (e.fadeIn || 0) / 2), lens: t.entries.map(e => e.end - e.start) };
    });
    check(tl.template === id, `${label}: timeline uses the style`);
    const offGrid = tl.cuts.filter(c => { const q = (c - beats.phase) / beats.period; return Math.abs(q - Math.round(q)) * beats.period > 0.002; });
    // the 6 s clip is shorter than some styles' slot; everything after it re-snaps to the grid
    check(offGrid.length <= 1, `${label}: ${tl.cuts.length - offGrid.length}/${tl.cuts.length} transitions centred on a beat`);
    if (id === 'beatdrop') check(Math.abs(tl.cuts[0] - beats.drop) < 1e-6, 'Beat Drop: first cut is the drop');
    await page.screenshot({ path: `${out}/editor-${id}.png`, fullPage: true });

    const file = `${out}/reel-${id}.mp4`;
    const info = await exportAndSave(page, file);
    const p = probe(file);
    check(p.v && p.v.width === 1080 && p.v.height === 1920, `${label}: 1080x1920 (${info.method})`);
    check(Math.abs(p.dur - tl.total) < (info.method === 'webcodecs' ? 0.1 : 0.3), `${label}: duration ${p.dur.toFixed(2)} ≈ ${tl.total.toFixed(2)}`);

    if (id === 'beatdrop' && info.method === 'webcodecs') {
      // find hard cuts in the real video and compare them with the beat grid
      const log = spawnSync('ffmpeg', ['-i', file, '-vf', "select='gt(scene,0.25)',showinfo", '-an', '-f', 'null', '-']).stderr.toString();
      const found = [...log.matchAll(/pts_time:([\d.]+)/g)].map(m => Number(m[1]));
      const planned = tl.cuts.filter(c => c < tl.total - 0.1);
      const matched = planned.filter(c => found.some(f => Math.abs(f - c) <= 1 / 30 + 0.005));
      check(matched.length >= planned.length - 1, `Beat Drop: ${matched.length}/${planned.length} planned beat cuts found in the MP4 within one frame`);
    }
    // frames to eyeball: the style's key moments
    const times = id === 'beatdrop' ? [1.0, tl.cuts[0] + 0.03, tl.cuts[0] + 0.3, tl.cuts[2] + 0.05]
      : id === 'dump' ? [0.3, tl.cuts[2] + 0.1, tl.cuts[4] + 0.4, tl.total - 0.9]
      : id === 'journey' ? [0.8, tl.cuts[0], tl.cuts[1] + 0.4, tl.cuts[3] + 0.4]
      : [1.2, tl.cuts[0], tl.cuts[1] + 1.0, tl.total - 1.5];
    times.forEach((t, i) => {
      const png = `${out}/t-${id}-${i}.png`;
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', Math.max(0, t).toFixed(3), '-i', file, '-frames:v', '1', '-vf', 'scale=270:-1', png]);
      sheet.push(png);
    });
    const vd = spawnSync('ffmpeg', ['-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.toString();
    const mean = Number((vd.match(/mean_volume: (-?[\d.]+) dB/) || [])[1]);
    check(mean > -45, `${label}: audio audible (${mean} dB)`);
  }
  // 4 rows (styles) x 4 frames
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...sheet.flatMap(f => ['-i', f]),
    '-filter_complex', `${sheet.map((_, i) => `[${i}]`).join('')}xstack=inputs=${sheet.length}:layout=${sheet.map((_, i) => `${(i % 4) * 270}_${Math.floor(i / 4) * 480}`).join('|')}`,
    `${out}/templates.png`]);
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await close();
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall passed');
