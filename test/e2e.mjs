// End-to-end: drive the app in an iPhone-sized browser, make a reel, check the MP4.
// Usage: node test/e2e.mjs [--force=realtime]
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const fx = f => path.join(root, 'test/fixtures', f);
const outDir = path.join(root, 'test/out');
mkdirSync(outDir, { recursive: true });
const force = (process.argv.find(a => a.startsWith('--force=')) || '').split('=')[1];

const port = 8765 + Math.floor(Math.random() * 500);
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ ...devices['iPhone 14'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    window.__transcribe = async () => [
      { text: 'Hello', start: 0.5, end: 0.9 }, { text: 'there', start: 1.0, end: 1.4 },
      { text: 'um', start: 2.0, end: 2.3 }, { text: 'welcome', start: 3.5, end: 4.0 }, { text: 'back.', start: 4.1, end: 4.6 },
    ];
  });
  if (process.argv.includes('--opus')) await page.addInitScript(() => { window.__testAudioCodec = 'opus'; });
  if (force) {
    await page.addInitScript(f => { window.__forceExport = f; }, force);
  }
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.setInputFiles('#pick', [fx('photo1.jpg'), fx('clip.mp4'), fx('photo2.jpg')]);
  await page.waitForFunction(() => document.querySelectorAll('#items li').length === 3, null, { timeout: 15000 });
  check(true, 'three items added');

  await page.fill('#title', 'Clearwater weekend');
  await page.fill('#subtitle', 'October 2026');
  await page.setInputFiles('#music', fx('music.mp3'));
  await page.waitForSelector('#music-opts:not(.hidden)');

  // wait for the clip's sound to be decoded, then turn on captions and pause cutting
  await page.waitForFunction(() => window.__app.state.items[1].audio !== undefined, null, { timeout: 10000 });
  await page.click('#items li:nth-child(2) >> text=Captions');
  await page.waitForFunction(() => !!window.__app.state.items[1].words);
  await page.click('#items li:nth-child(2) >> text=Cut pauses');
  const tl = await page.evaluate(() => {
    const t = window.__app.state.tl;
    return { total: t.total, pieces: t.entries[1].pieces.length, cues: t.cues.length };
  });
  console.log('timeline', tl);
  check(tl.pieces === 2, 'clip cut into two pieces around the pause');
  check(tl.cues >= 1, 'caption cues built');
  await page.screenshot({ path: path.join(outDir, 'editor.png'), fullPage: true });

  // top bar band stays put while scrolling
  const barTop = await page.evaluate(async () => {
    const a = document.querySelector('header.bar').getBoundingClientRect().height;
    window.scrollTo(0, 99999); await new Promise(r => setTimeout(r, 100));
    const b = document.querySelector('header.bar').getBoundingClientRect();
    return { a, b: b.height, top: b.top };
  });
  check(barTop.a === barTop.b && barTop.top === 0, 'top bar sticky with a fixed height');

  const t0 = Date.now();
  await page.click('#export');
  await page.waitForSelector('#result:not(.hidden)', { timeout: 180000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const info = await page.evaluate(async () => {
    const o = window.__app.state.output;
    const buf = new Uint8Array(await o.file.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), method: o.method, type: o.file.type, name: o.file.name };
  });
  console.log(`exported in ${secs}s via ${info.method} as ${info.type}`);
  const file = path.join(outDir, info.name);
  writeFileSync(file, Buffer.from(info.b64, 'base64'));
  await page.screenshot({ path: path.join(outDir, 'result.png'), fullPage: true });

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  const v = probe.streams.find(s => s.codec_type === 'video');
  const a = probe.streams.find(s => s.codec_type === 'audio');
  const dur = Number(probe.format.duration);
  console.log('probe', { v: v && `${v.codec_name} ${v.width}x${v.height}`, a: a && `${a.codec_name} ${a.sample_rate}`, dur });
  check(v && v.width === 1080 && v.height === 1920, 'video is 1080x1920');
  if (info.method === 'webcodecs') {
    check(v.codec_name === 'h264', 'video codec is H.264');
    check(a && a.codec_name === (process.argv.includes('--opus') ? 'opus' : 'aac'), 'audio codec as configured');
  } else {
    check(!!a, 'recording has audio');
  }
  check(Math.abs(dur - tl.total) < (info.method === 'webcodecs' ? 0.1 : 0.3), `duration ${dur.toFixed(2)} matches timeline ${tl.total.toFixed(2)}`);

  // frames for eyeballing: title card, mid clip with caption, end
  for (const [name, t] of [['f-title', 1.5], ['f-clip', 3.6], ['f-end', Math.max(0, tl.total - 1.2)]]) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-1', path.join(outDir, `${name}.png`)]);
  }
  // audio is not silent
  const vd = spawnSync('ffmpeg', ['-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.toString();
  const mean = Number((vd.match(/mean_volume: (-?[\d.]+) dB/) || [])[1]);
  check(mean > -45, `audio is audible (mean ${mean} dB)`);
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nall passed');
