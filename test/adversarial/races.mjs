import { open, addFiles } from './harness.mjs';
// instrument live (non-offline) AudioBufferSourceNodes so we can see ghost playback
const instrument = () => {
  window.__live = new Set();
  const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (...a) {
    if (!(this.context instanceof OfflineAudioContext)) { window.__live.add(this); this.addEventListener('ended', () => window.__live.delete(this)); }
    return start.apply(this, a);
  };
  AudioBufferSourceNode.prototype.stop = function (...a) { window.__live.delete(this); return stop.apply(this, a); };
  // slow the offline mix (an iPhone mixing 60 s takes a while)
  const sr = OfflineAudioContext.prototype.startRendering;
  OfflineAudioContext.prototype.startRendering = function () { const p = sr.call(this); return this.length > 16000 * 30 ? p.then(b => new Promise(r => setTimeout(() => r(b), window.__mixDelay || 0))) : p; };
};
const slowDecode = () => {
  const d = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (...a) { return d.apply(this, a).then(b => new Promise(r => setTimeout(() => r(b), window.__decodeDelay || 0))); };
};
const { page, errors, close } = await open({ init: [instrument, slowDecode] });
const live = () => page.evaluate(() => window.__live.size);
try {
  // R1: export started while a clip's sound is still decoding
  await page.evaluate(() => { window.__decodeDelay = 4000; });
  await addFiles(page, ['photo1.jpg', 'clip.mp4'], 2);
  await page.click('#export');
  await page.waitForTimeout(500);
  const during = await page.evaluate(() => ({ exporting: !!window.__app.state.exporting, audio: window.__app.state.items[1].audio }));
  await page.waitForFunction(() => window.__app.state.items[1].audio !== undefined, null, { timeout: 20000 });
  await page.waitForFunction(() => !window.__app.state.exporting, null, { timeout: 60000 });
  console.log('R1 export while decoding:', JSON.stringify(during), '-> result shown:', await page.isVisible('#result'), '| err:', JSON.stringify(await page.textContent('#export-err')));
  await page.evaluate(() => { window.__decodeDelay = 0; });

  // R2: stale soundtrack cached after an edit during mixing
  await page.evaluate(() => { window.__mixDelay = 1500; });
  await addFiles(page, ['photo2.jpg'], 3);
  await page.waitForTimeout(300);
  await page.click('#play');
  await page.waitForTimeout(300);           // mixing in progress
  await page.click('#items li:nth-child(3) button[aria-label^=Remove]');  // edit -> invalidate
  await page.waitForTimeout(2500);
  const r2 = await page.evaluate(() => ({ tl: window.__app.state.tl.total, st: window.__app.state.soundtrack && window.__app.state.soundtrack.buffer && window.__app.state.soundtrack.buffer.duration, player: !!window.__app.state.player, playText: document.querySelector('#play').textContent }));
  console.log('R2 stale cache:', JSON.stringify(r2), '| live sources', await live());
  await page.waitForTimeout(6000);
  await page.evaluate(() => { window.__mixDelay = 0; });

  // R3: change title right after Play (during player startup) -> ghost playback
  await page.evaluate(() => window.__app.invalidate());
  await page.click('#play');
  await page.waitForTimeout(30);
  await page.fill('#title', 'x');
  await page.waitForTimeout(800);
  console.log('R3 after title edit during startup: state.player', await page.evaluate(() => !!window.__app.state.player), '| play label', await page.textContent('#play'), '| live sources still playing', await live());
  await page.waitForTimeout(8000);

  // R4: double tap Play while mixing
  await page.evaluate(() => { window.__mixDelay = 800; window.__app.invalidate(); });
  await page.click('#play'); await page.waitForTimeout(100); await page.click('#play');
  await page.waitForTimeout(1500);
  console.log('R4 double-tap: live sources', await live(), '| label', await page.textContent('#play'));
  await page.click('#play'); await page.waitForTimeout(300);
  console.log('R4 after pressing Stop: live sources', await live(), '| label', await page.textContent('#play'));
  console.log('errors', JSON.stringify(errors));
} finally { await close(); }
