// An unreadable file shows an error and the rest still loads; a 0.25 s clip is skipped with a note.
import { open } from './harness.mjs';
const { page, errors, close } = await open();
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed++; };
try {
  await page.setInputFiles('#pick', ['garbage.mp4', 'short025.mp4', 'photo1.jpg', 'noaudio.mp4'].map(f => `test/fixtures/${f}`));
  await page.waitForFunction(() => document.querySelectorAll('#items li').length === 3, null, { timeout: 30000 });
  await page.waitForFunction(() => window.__app.state.items.every(i => i.kind !== 'video' || i.audio !== undefined));
  const err = await page.textContent('#media-err');
  check(/garbage\.mp4/.test(err), `error names the bad file: "${err.trim()}"`);
  check(await page.isVisible('#skipped'), 'short clip note shown');
  check(await page.evaluate(() => document.querySelectorAll('#media video').length) === 2, 'failed video element removed');
  check(/no sound/.test(await page.textContent('#items')), 'clip without audio says no sound');
  check(!(await page.isDisabled('#export')), 'Make video enabled');
  check(errors.filter(e => !/garbage|MEDIA_ERR|Failed to load/i.test(e)).length === 0, 'no unexpected console errors ' + JSON.stringify(errors));
} finally { await close(); }
process.exit(failed ? 1 : 0);
