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
  OfflineAudioContext.prototype.startRendering = function () { const p = sr.call(this); return this.length > 48000 ? p.then(b => new Promise(r => setTimeout(() => r(b), window.__mixDelay || 0))) : p; };
};
const slowDecode = () => {
  const d = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (...a) { return d.apply(this, a).then(b => new Promise(r => setTimeout(() => r(b), window.__decodeDelay || 0))); };
};
const { page, errors, close } = await open({ init: [instrument, slowDecode] });
const live = () => page.evaluate(() => window.__live.size);
try {
  const delaySeeked = () => {
    const ael = HTMLMediaElement.prototype.addEventListener;
    HTMLMediaElement.prototype.addEventListener = function (t, fn, o) { if (t === 'seeked' && window.__seekDelay) { const f = fn; fn = (...a) => setTimeout(() => f(...a), window.__seekDelay); } return ael.call(this, t, fn, o); };
  };
  await page.evaluate(delaySeeked);
  await addFiles(page, ['clip.mp4', 'photo1.jpg'], 2);
  await page.waitForFunction(() => window.__app.state.items[0].audio !== undefined);
  // R3: edit during player startup (seek wait) -> ghost playback
  await page.evaluate(() => { window.__seekDelay = 1200; });
  await page.click('#play');
  await page.waitForTimeout(400);
  await page.fill('#title', 'x');
  await page.waitForTimeout(2000);
  console.log('R3 after title edit during startup: state.player', await page.evaluate(() => !!window.__app.state.player), '| label', await page.textContent('#play'), '| live sources playing', await live());
  await page.evaluate(() => { window.__seekDelay = 0; });
  await page.waitForTimeout(9000);
  console.log('R3 after reel length elapsed: live', await live());
  // R4: double tap Play while mixing
  await page.evaluate(() => { window.__mixDelay = 800; window.__app.invalidate(); });
  await page.click('#play'); await page.waitForTimeout(100); await page.click('#play');
  await page.waitForTimeout(1500);
  console.log('R4 double-tap: live sources', await live(), '| label', await page.textContent('#play'));
  await page.click('#play'); await page.waitForTimeout(300);
  console.log('R4 after pressing Stop: live sources', await live(), '| label', await page.textContent('#play'));
  console.log('errors', JSON.stringify(errors));
} finally { await close(); }
