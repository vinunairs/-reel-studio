// Draws one frame of the "Postcard" template onto a 1080x1920 canvas.
import { WIDTH, HEIGHT, XFADE, visibleAt, sourceTimeAt } from './timeline.js';
import { DRAW } from './fx.js';

const ACCENT = '#FFD166';

// Seek every video visible at time t to the right source frame (used for export,
// where frames are rendered one at a time rather than played).
export async function seekFor(tl, t) {
  const waits = [];
  for (const { entry } of visibleAt(tl.entries, t)) {
    const { item } = entry;
    if (item.kind !== 'video') continue;
    const src = sourceTimeAt(entry, t);
    const v = item.el;
    const target = Math.min(src, Math.max(0, (v.duration || item.srcDuration) - 0.04));
    if (Math.abs(v.currentTime - target) < 0.001 && v.readyState >= 2) continue;
    waits.push(seekVideo(v, target));
  }
  await Promise.all(waits);
}

// Seeks with a timeout. A clip that misses several seeks in a row is treated as
// unreadable, so one bad file can't stall the export for half an hour.
export function seekVideo(v, time) {
  if ((v.__missedSeeks || 0) >= 3) return Promise.reject(new Error('One of the clips can’t be read frame by frame. Remove it or re-save it from Photos.'));
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; v.removeEventListener('seeked', onSeeked); clearTimeout(timer); v.__missedSeeks = ok ? 0 : (v.__missedSeeks || 0) + 1; resolve(); };
    const onSeeked = () => finish(true);
    const timer = setTimeout(() => finish(false), 2000);
    v.addEventListener('seeked', onSeeked);
    v.currentTime = time;
  });
}

function coverRect(sw, sh, dw, dh) {
  const s = Math.max(dw / sw, dh / sh);
  return { w: sw * s, h: sh * s };
}

function drawMedia(ctx, entry, t, alpha) {
  const { item } = entry;
  const el = item.el;
  const sw = item.kind === 'photo' ? (el.naturalWidth || el.width) : el.videoWidth;
  const sh = item.kind === 'photo' ? (el.naturalHeight || el.height) : el.videoHeight;
  if (!sw || !sh) return;
  const base = coverRect(sw, sh, WIDTH, HEIGHT);
  let scale = 1, dx = 0, dy = 0;
  if (item.kind === 'photo') {
    // slow push-in, drifting a different way on each photo
    const p = Math.min(1, Math.max(0, (t - entry.start) / Math.max(0.1, entry.end - entry.start)));
    scale = 1.02 + 0.08 * p;
    const dir = [[1, 0], [-1, 0], [0, 1], [0, -1]][entry.index % 4];
    dx = dir[0] * 40 * (p - 0.5);
    dy = dir[1] * 60 * (p - 0.5);
  }
  const w = base.w * scale, h = base.h * scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(el, (WIDTH - w) / 2 + dx, (HEIGHT - h) / 2 + dy, w, h);
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTitle(ctx, t, title, subtitle) {
  if (!title && !subtitle) return;
  const shown = 3.2;
  if (t > shown) return;
  const a = Math.min(1, t / 0.5, (shown - t) / 0.5);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  const g = ctx.createLinearGradient(0, HEIGHT * 0.45, 0, HEIGHT);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = g;
  ctx.fillRect(0, HEIGHT * 0.45, WIDTH, HEIGHT * 0.55);
  const rise = (1 - Math.min(1, t / 0.6)) * 30;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let y = HEIGHT - 380 + rise;
  if (title) {
    const lines = wrap(ctx, title, '600 112px ui-serif, "New York", Georgia, serif', WIDTH - 160, 2);
    ctx.font = '600 112px ui-serif, "New York", Georgia, serif';
    const startY = y - (lines.length - 1) * 120;
    lines.forEach((l, i) => ctx.fillText(l, 80, startY + i * 120));
  }
  if (subtitle) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(80, y + 48, 64, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '500 48px -apple-system, system-ui, sans-serif';
    ctx.fillText(subtitle, 80, y + 130);
  }
  ctx.restore();
}

function wrap(ctx, text, font, maxW, maxLines) {
  ctx.font = font;
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] += '…';
    return kept;
  }
  return lines;
}

function drawCaption(ctx, cues, t) {
  const cue = cues.find(c => t >= c.start && t <= c.end);
  if (!cue) return;
  ctx.save();
  ctx.font = '700 64px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const space = ctx.measureText(' ').width;
  const widths = cue.words.map(w => ctx.measureText(w.text).width);
  const lineW = widths.reduce((a, b) => a + b, 0) + space * (cue.words.length - 1);
  const padX = 36, h = 104, y = HEIGHT - 520;
  const boxW = Math.min(WIDTH - 80, lineW + padX * 2);
  const x0 = (WIDTH - boxW) / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(ctx, x0, y - h / 2, boxW, h, 28);
  ctx.fill();
  let x = (WIDTH - lineW) / 2;
  cue.words.forEach((w, i) => {
    ctx.fillStyle = t >= w.start && t <= w.end + 0.1 ? ACCENT : '#fff';
    ctx.fillText(w.text, x, y + 2);
    x += widths[i] + space;
  });
  ctx.restore();
}

export function drawFrame(ctx, tl, t, opts = {}) {
  const template = DRAW[tl.template];
  if (template) {
    template(ctx, tl, t, opts);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    for (const { entry, alpha } of visibleAt(tl.entries, t)) drawMedia(ctx, entry, t, alpha);
    drawTitle(ctx, t, opts.title, opts.subtitle);
  }
  drawCaption(ctx, tl.cues, t);
  // fade to black at the end
  const tail = tl.total - t;
  if (tail < 0.6) {
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, Math.max(0, 1 - tail / 0.6))})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

export { XFADE };
