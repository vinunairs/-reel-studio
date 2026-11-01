import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
export const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const fx = f => f.startsWith('/') ? f : `${root}/test/fixtures/${f}`;
export async function open({ opus = true, force, init = [], flags = ['--autoplay-policy=no-user-gesture-required'] } = {}) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const browser = await chromium.launch({ args: flags });
  const ctx = await browser.newContext({ ...devices['iPhone 14'] });
  const page = await ctx.newPage();
  const errors = [], requests = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && errors.push(m.type() + ': ' + m.text()));
  page.on('request', r => requests.push({ m: r.method(), u: r.url(), post: r.postData() ? r.postData().length : 0 }));
  await page.addInitScript(() => {
    window.__transcribe = async () => [
      { text: 'Hello', start: 0.5, end: 0.9 }, { text: 'there', start: 1.0, end: 1.4 },
      { text: 'um', start: 2.0, end: 2.3 }, { text: 'welcome', start: 3.5, end: 4.0 }, { text: 'back.', start: 4.1, end: 4.6 }];
  });
  if (opus) await page.addInitScript(() => { window.__testAudioCodec = 'opus'; });
  if (force) await page.addInitScript(f => { window.__forceExport = f; }, force);
  for (const s of init) await page.addInitScript(s);
  await page.goto(`http://127.0.0.1:${port}/`);
  const close = async () => { await browser.close(); server.kill(); };
  return { page, errors, requests, close, port };
}
export async function addFiles(page, files, n) {
  await page.setInputFiles('#pick', files.map(fx));
  await page.waitForFunction(n => document.querySelectorAll('#items li').length === n, n, { timeout: 30000 });
}
export async function exportAndSave(page, file, timeout = 240000) {
  await page.click('#export');
  await page.waitForSelector('#result:not(.hidden)', { timeout });
  const info = await page.evaluate(async () => {
    const o = window.__app.state.output;
    const buf = new Uint8Array(await o.file.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { b64: btoa(s), method: o.method, total: window.__app.state.tl.total };
  });
  writeFileSync(file, Buffer.from(info.b64, 'base64'));
  return info;
}
export function probe(file) {
  const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  return { dur: Number(p.format.duration), v: p.streams.find(s => s.codec_type === 'video'), a: p.streams.find(s => s.codec_type === 'audio'),
    vdur: Number((p.streams.find(s => s.codec_type === 'video') || {}).duration), adur: Number((p.streams.find(s => s.codec_type === 'audio') || {}).duration) };
}
export { spawnSync, execFileSync };
