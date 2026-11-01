// Frame drawing for the beat templates: Beat Drop, Photo Dump, Journey, Cinematic Memory.
// Each draws one 1080x1920 frame at time t. Built to stay cheap on an iPhone: no canvas
// `filter` (patchy on Safari), blur by down-and-up scaling, a small reused scratch canvas.
import { WIDTH as W, HEIGHT as H, visibleAt } from './timeline.js';

const ACCENT = '#FFD166';
const SANS = '-apple-system, "SF Pro Display", system-ui, "Liberation Sans", sans-serif';
const SERIF = 'ui-serif, "New York", Georgia, "DejaVu Serif", serif';

const ease = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = x => Math.max(0, Math.min(1, x));
function hash(n) { let x = (n + 1) * 2654435761 >>> 0; x ^= x >>> 13; x = Math.imul(x, 1274126177) >>> 0; return (x >>> 8) / 16777216; }

function mediaSize(item) {
  const el = item.el;
  if (!el) return null;
  const w = item.kind === 'photo' ? (el.naturalWidth || el.width) : el.videoWidth;
  const h = item.kind === 'photo' ? (el.naturalHeight || el.height) : el.videoHeight;
  return w && h ? { w, h } : null;
}

// Draw media covering the box (x, y, w, h), zoomed by `scale` and shifted by (dx, dy).
function cover(ctx, item, x, y, w, h, scale = 1, dx = 0, dy = 0) {
  const s0 = mediaSize(item);
  if (!s0) return;
  const s = Math.max(w / s0.w, h / s0.h) * scale;
  const iw = s0.w * s, ih = s0.h * s;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(item.el, x + (w - iw) / 2 + dx, y + (h - ih) / 2 + dy, iw, ih);
  ctx.restore();
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function textBox(ctx, text, y, font, maxW = W - 120) {
  ctx.save();
  ctx.font = font;
  let t = text;
  while (ctx.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -2);
  if (t !== text) t = t.trimEnd() + '…';
  const tw = ctx.measureText(t).width, th = parseInt(font.match(/(\d+)px/)[1], 10);
  rr(ctx, (W - tw) / 2 - 34, y - th / 2 - 22, tw + 68, th + 44, 18);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(t, W / 2, y + 2);
  ctx.restore();
}

function vignette(ctx, strength = 0.5, y0 = 0, h = H) {
  const g = ctx.createRadialGradient(W / 2, y0 + h / 2, h * 0.25, W / 2, y0 + h / 2, h * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g; ctx.fillRect(0, y0, W, h);
}

let scratch = null;
function getScratch(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  return scratch;
}

// Soft blurred backdrop: shrink to a tiny canvas, then stretch back up.
let tiny = null;
function blurredBackdrop(ctx, item, darken = 0.5) {
  if (!tiny) { tiny = document.createElement('canvas'); tiny.width = 27; tiny.height = 48; }
  const tg = tiny.getContext('2d');
  tg.fillStyle = '#000'; tg.fillRect(0, 0, 27, 48);
  const s0 = mediaSize(item);
  if (s0) { const s = Math.max(27 / s0.w, 48 / s0.h) * 1.2; tg.drawImage(item.el, (27 - s0.w * s) / 2, (48 - s0.h * s) / 2, s0.w * s, s0.h * s); }
  ctx.save();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tiny, -40, -40, W + 80, H + 80);
  ctx.fillStyle = `rgba(0,0,0,${darken})`; ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function beatAt(beats, t) {
  if (!beats || !(beats.period > 0)) return { since: 1, index: 0 };
  const k = Math.floor((t - beats.phase) / beats.period);
  return { since: t - (beats.phase + k * beats.period), index: k };
}

// ---------------- Beat Drop ----------------
function drawPunched(ctx, entry, t, scale, split) {
  if (split < 0.5) { cover(ctx, entry.item, 0, 0, W, H, scale); return; }
  // RGB split: one tinted copy per channel, added together, offset sideways
  const sc = getScratch(W, H), sg = sc.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [col, dx] of [['#ff0000', -split], ['#00ff00', 0], ['#0000ff', split]]) {
    sg.globalCompositeOperation = 'source-over';
    sg.fillStyle = '#000'; sg.fillRect(0, 0, W, H);
    cover(sg, entry.item, 0, 0, W, H, scale, dx);
    sg.globalCompositeOperation = 'multiply';
    sg.fillStyle = col; sg.fillRect(0, 0, W, H);
    ctx.drawImage(sc, 0, 0);
  }
  ctx.restore();
}

function beatDrop(ctx, tl, t, opts) {
  const { entries, beats } = tl;
  const dropT = entries.length > 1 ? entries[1].start : Infinity;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const b = beatAt(beats, t);
  if (t < dropT) {
    // teaser: the first item, dark, slowly pushing in, with a white blink on every beat
    const e = entries[0];
    const p = clamp01(t / Math.max(0.5, dropT));
    cover(ctx, e.item, 0, 0, W, H, 1.0 + 0.06 * p);
    ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(255,255,255,${0.28 * Math.exp(-b.since / 0.09)})`; ctx.fillRect(0, 0, W, H);
    vignette(ctx, 0.55);
    if (opts.title) textBox(ctx, opts.title, 430, `800 66px ${SANS}`);
    // beats counting down to the drop
    if (beats && Number.isFinite(dropT)) {
      const n = Math.max(1, Math.min(16, Math.round((dropT - Math.max(0, beats.phase)) / beats.period)));
      const left = Math.max(0, Math.round((dropT - t) / beats.period));
      const cur = n - left, gap = 44, x0 = W / 2 - (n - 1) * gap / 2, y = H - 260;
      for (let i = 0; i < n; i++) {
        ctx.beginPath(); ctx.arc(x0 + i * gap, y, i === cur ? 15 : 8, 0, Math.PI * 2);
        ctx.fillStyle = i < cur ? 'rgba(255,255,255,0.9)' : i === cur ? ACCENT : 'rgba(255,255,255,0.3)';
        ctx.fill();
      }
    }
    return;
  }
  const vis = visibleAt(entries, t);
  const cur = vis.length ? vis[vis.length - 1].entry : entries[entries.length - 1];
  const since = Math.max(0, t - cur.start);
  const e = Math.exp(-since / 0.12);
  // alternate punch-in and pull-out on every cut, with a slow push in between
  const scale = cur.index % 2 ? 1.04 + 0.08 * (1 - e) : 1.06 + 0.12 * e;
  drawPunched(ctx, cur, t, scale, since < 0.18 ? 12 * e : 0);
  const sinceDrop = t - dropT;
  const flash = Math.max(0.85 * Math.exp(-sinceDrop / 0.25), 0.16 * Math.exp(-since / 0.08), 0.06 * Math.exp(-b.since / 0.08));
  ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, W, H);
  vignette(ctx, 0.45);
}

// ---------------- Photo Dump ----------------
function printPose(index) {
  return { rot: (hash(index) * 2 - 1) * 9 * Math.PI / 180, dx: (hash(index + 101) * 2 - 1) * 50, dy: (hash(index + 202) * 2 - 1) * 40 };
}

function drawPrint(ctx, entry, cx, cy, rot, scale, alpha, withCaption) {
  const pw = 800, ph = 1000, border = 34, bottom = 150;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy); ctx.rotate(rot); ctx.scale(scale, scale);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
  ctx.fillStyle = '#fbf8f1';
  ctx.fillRect(-pw / 2, -ph / 2, pw, ph + bottom - border);
  ctx.shadowColor = 'transparent';
  cover(ctx, entry.item, -pw / 2 + border, -ph / 2 + border, pw - border * 2, ph - border * 2);
  const place = (entry.item.place || '').trim();
  if (withCaption && place) {
    ctx.fillStyle = '#3a3a3a'; ctx.font = `italic 500 54px ${SERIF}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let s = place; while (ctx.measureText(s).width > pw - border * 2 - 12 && s.length > 3) s = s.slice(0, -2);
    ctx.fillText(s === place ? s : s.trimEnd() + '…', -pw / 2 + border + 6, ph / 2 + 40);
  }
  if (withCaption) { // a strip of tape
    ctx.fillStyle = 'rgba(255,240,180,0.75)';
    ctx.save(); ctx.translate(0, -ph / 2 - 6); ctx.rotate(-0.05); ctx.fillRect(-110, -26, 220, 52); ctx.restore();
  }
  ctx.restore();
}

function header(ctx, title, right) {
  ctx.save();
  ctx.textBaseline = 'middle';
  if (right) {
    ctx.font = `700 46px ${SANS}`;
    const w = Math.max(180, ctx.measureText(right).width + 60);
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; rr(ctx, W - 70 - w, 152, w, 84, 42); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(right, W - 70 - w / 2, 196);
  }
  if (title) {
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = `800 76px ${SANS}`;
    let s = title; while (ctx.measureText(s).width > W - 420 && s.length > 3) s = s.slice(0, -2);
    ctx.fillText(s === title ? s : s.trimEnd() + '…', 80, 196);
  }
  ctx.restore();
}

function photoDump(ctx, tl, t, opts) {
  const { entries } = tl;
  if (!entries.length) return;
  if (t >= tl.outroStart && tl.total > tl.outroStart) { dumpGrid(ctx, tl, t - tl.outroStart, opts); return; }
  const vis = visibleAt(entries, t);
  const cur = vis.length ? vis[vis.length - 1].entry : entries[0];
  blurredBackdrop(ctx, cur.item, 0.45);
  const since = Math.max(0, t - cur.start);
  for (let j = Math.max(0, cur.index - 3); j <= cur.index; j++) {
    const pose = printPose(j);
    const top = j === cur.index;
    // the newest print drops in on the beat
    const land = top ? ease(clamp01(since / 0.2)) : 1;
    drawPrint(ctx, entries[j], W / 2 + pose.dx, H / 2 - 40 + pose.dy, pose.rot, 1.22 - 0.22 * land, top ? land : 1, top);
  }
  header(ctx, opts.title, `${String(cur.index + 1).padStart(2, '0')} / ${String(entries.length).padStart(2, '0')}`);
}

function dumpGrid(ctx, tl, u, opts) {
  const { entries } = tl;
  blurredBackdrop(ctx, entries[entries.length - 1].item, 0.6);
  const shown = entries.slice(0, 12);
  const cols = shown.length > 4 ? 3 : 2, rows = Math.ceil(shown.length / cols);
  const cw = (W - 120) / cols, ch = Math.min(cw * 1.3, (H - 520) / rows);
  shown.forEach((e, i) => {
    const a = clamp01((u - i * 0.06) / 0.25);
    if (a <= 0) return;
    const cx = 60 + cw * (i % cols) + cw / 2, cy = 400 + ch * Math.floor(i / cols) + ch / 2;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy); ctx.rotate((hash(i + 7) * 2 - 1) * 4 * Math.PI / 180); ctx.scale(0.9 + 0.1 * ease(a), 0.9 + 0.1 * ease(a));
    const pw = cw - 24, ph = ch - 24;
    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#fbf8f1'; ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
    ctx.shadowColor = 'transparent';
    cover(ctx, e.item, -pw / 2 + 12, -ph / 2 + 12, pw - 24, ph - 24);
    ctx.restore();
  });
  header(ctx, opts.title, `${entries.length} moments`);
}

// ---------------- Journey ----------------
function smear(ctx, item, x, blur, scale) {
  if (blur < 2) { cover(ctx, item, 0, 0, W, H, scale, x); return; }
  // a running average of shifted copies = directional motion blur
  const n = 10;
  ctx.save();
  for (let k = 0; k < n; k++) {
    ctx.globalAlpha = 1 / (k + 1);
    cover(ctx, item, 0, 0, W, H, scale, x + (k / (n - 1) - 0.5) * blur);
  }
  ctx.restore();
}

function journey(ctx, tl, t, opts) {
  const { entries } = tl;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const vis = visibleAt(entries, t);
  if (!vis.length) return;
  const inc = vis[vis.length - 1];
  const out = vis.length > 1 ? vis[0] : null;
  const push = e => 1.04 + 0.06 * clamp01((t - e.start) / Math.max(0.1, e.end - e.start));
  if (out) {
    const p = ease(inc.alpha), dir = inc.entry.index % 2 ? -1 : 1, blur = 220 * Math.sin(Math.PI * inc.alpha);
    smear(ctx, out.entry.item, -dir * W * p, blur, push(out.entry));
    smear(ctx, inc.entry.item, dir * W * (1 - p), blur, push(inc.entry));
    const seam = W / 2 + dir * W * (0.5 - p);
    const g = ctx.createLinearGradient(seam - 160, 0, seam + 160, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${0.25 * Math.sin(Math.PI * inc.alpha)})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else {
    cover(ctx, inc.entry.item, 0, 0, W, H, push(inc.entry));
  }
  const main = out && inc.alpha < 0.5 ? out.entry : inc.entry;
  let g = ctx.createLinearGradient(0, 0, 0, 520);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 520);
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  if (opts.title) { ctx.fillStyle = ACCENT; ctx.font = `800 40px ${SANS}`; ctx.fillText(opts.title.toUpperCase().slice(0, 32), 80, 200); }
  const place = (main.item.place || '').trim();
  if (place) {
    const a = ease(clamp01((t - main.start - main.fadeIn / 2) / 0.35));
    ctx.globalAlpha = Math.max(0.0001, a);
    ctx.font = `700 56px ${SANS}`;
    let label = place; while (ctx.measureText(label).width > W - 320 && label.length > 3) label = label.slice(0, -2);
    if (label !== place) label = label.trimEnd() + '…';
    const lw = ctx.measureText(label).width, x = 80 - 60 * (1 - a);
    ctx.fillStyle = 'rgba(255,255,255,0.94)'; rr(ctx, x, 250, lw + 150, 104, 52); ctx.fill();
    pin(ctx, x + 60, 288, 22, '#E63946');
    ctx.fillStyle = '#111'; ctx.fillText(label, x + 106, 304);
  }
  ctx.restore();
  routeBar(ctx, entries, main);
}

function pin(ctx, x, y, s, col) {
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, s, Math.PI, 0);
  ctx.quadraticCurveTo(x + s, y + s * 0.9, x, y + s * 2.1); ctx.quadraticCurveTo(x - s, y + s * 0.9, x - s, y); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, s * 0.4, 0, Math.PI * 2); ctx.fill();
}

// Distinct places in order; consecutive photos at the same place share one stop.
export function routeStops(entries) {
  const stops = [];
  for (const e of entries) {
    const p = (e.item.place || '').trim();
    if (!p) continue;
    if (!stops.length || stops[stops.length - 1].name.toLowerCase() !== p.toLowerCase()) stops.push({ name: p, first: e.index });
  }
  return stops;
}

function routeBar(ctx, entries, main) {
  const stops = routeStops(entries).slice(0, 6);
  if (stops.length < 2) return;
  let cur = -1;
  stops.forEach((s, i) => { if (s.first <= main.index) cur = i; });
  const g = ctx.createLinearGradient(0, H - 420, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = g; ctx.fillRect(0, H - 420, W, 420);
  const y = H - 230, x0 = 130, x1 = W - 130, step = (x1 - x0) / (stops.length - 1);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineWidth = 8;
  ctx.setLineDash([4, 18]); ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  ctx.setLineDash([]);
  if (cur > 0) { ctx.strokeStyle = ACCENT; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + step * cur, y); ctx.stroke(); }
  const size = stops.length > 4 ? 30 : 36;
  stops.forEach((s, i) => {
    const x = x0 + i * step;
    ctx.beginPath(); ctx.arc(x, y, i === cur ? 20 : 12, 0, Math.PI * 2);
    ctx.fillStyle = i <= cur ? ACCENT : 'rgba(255,255,255,0.8)'; ctx.fill();
    ctx.fillStyle = i === cur ? '#fff' : 'rgba(255,255,255,0.75)';
    ctx.font = `${i === cur ? 700 : 500} ${size}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let n = s.name; while (ctx.measureText(n).width > step * 0.95 + 40 && n.length > 3) n = n.slice(0, -2);
    ctx.fillText(n === s.name ? n : n.trimEnd() + '…', x, y + 62);
  });
  ctx.restore();
}

// ---------------- Cinematic Memory ----------------
let noise = null;
function noiseTile() {
  if (noise) return noise;
  noise = document.createElement('canvas'); noise.width = 256; noise.height = 256;
  const g = noise.getContext('2d'), id = g.createImageData(256, 256);
  let s = 12345;
  for (let i = 0; i < id.data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = 128 + ((s >>> 24) - 128) * 0.9;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return noise;
}

export const CINE_WINDOW = 1240;

function cinematic(ctx, tl, t, opts) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const h = CINE_WINDOW, y0 = (H - h) / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, y0, W, h); ctx.clip();
  for (const { entry, alpha } of visibleAt(tl.entries, t)) {
    const p = clamp01((t - entry.start) / Math.max(0.1, entry.end - entry.start));
    const dir = entry.index % 2 ? 1 : -1;
    ctx.globalAlpha = alpha;
    cover(ctx, entry.item, 0, y0, W, h, 1.05 + 0.06 * p, dir * 30 * (p - 0.5), 0);
  }
  ctx.globalAlpha = 1;
  // warm grade: amber soft light, lifted blacks, vignette
  ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(255,154,60,0.85)'; ctx.fillRect(0, y0, W, h);
  ctx.globalCompositeOperation = 'lighten'; ctx.fillStyle = '#1d140c'; ctx.fillRect(0, y0, W, h);
  ctx.globalCompositeOperation = 'source-over';
  vignette(ctx, 0.5, y0, h);
  // film grain that moves every frame
  const frame = Math.floor(t * 30);
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.16;
  const n = noiseTile(), ox = -Math.floor(hash(frame) * 256), oy = -Math.floor(hash(frame + 999) * 256);
  for (let y = y0 + oy; y < y0 + h; y += 256) for (let x = ox; x < W; x += 256) ctx.drawImage(n, x, y);
  ctx.restore();
  // titles live in the letterbox bands
  const a = clamp01((t - 0.6) / 0.8) * clamp01((tl.total - t) / 0.8);
  ctx.save();
  ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (opts.title) {
    ctx.fillStyle = '#f4e9d8'; ctx.font = `italic 400 84px ${SERIF}`;
    let s = opts.title; while (ctx.measureText(s).width > W - 120 && s.length > 3) s = s.slice(0, -2);
    ctx.fillText(s === opts.title ? s : s.trimEnd() + '…', W / 2, y0 + h + 150);
  }
  if (opts.subtitle) {
    ctx.fillStyle = 'rgba(244,233,216,0.7)'; ctx.font = `500 32px ${SANS}`;
    ctx.fillText(opts.subtitle.toUpperCase().slice(0, 34).split('').join(' '), W / 2, y0 + h + 215);
  }
  ctx.fillStyle = 'rgba(244,233,216,0.45)'; ctx.font = `500 30px ${SANS}`;
  ctx.fillText('a family film', W / 2, y0 - 70);
  ctx.restore();
}

export const DRAW = { beatdrop: beatDrop, dump: photoDump, journey, cinematic };
