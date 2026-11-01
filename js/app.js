import { buildTimeline, formatTime } from './timeline.js';
import { drawFrame, seekFor } from './render.js';
import { decodeFile, mixSoundtrack } from './audio.js';
import { Player, audioContext } from './player.js';
import { exportReel, exportMethod } from './export.js';
import { transcribe } from './captions.js';

export const VERSION = '0.2.0';

const $ = id => document.getElementById(id);
const state = {
  items: [],
  music: null,         // { file, buffer }
  musicVolume: 0.8,
  duck: true,
  tl: null,
  soundtrack: null,    // mixed AudioBuffer, cached until something changes
  player: null,
  exporting: null,     // AbortController
  output: null,        // { blob, url, method }
  pendingRefresh: false,
};
let nextId = 1;

// ---------- adding media ----------

function waitFor(el, event, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Low Power Mode can skip preloading; metadata is enough to carry on
      if (el.readyState >= 1) resolve(); else reject(new Error('This file took too long to open'));
    }, ms);
    el.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not open this file')); }, { once: true });
  });
}

// Big photos are shrunk once, so 20 of them don't use a gigabyte of memory.
async function loadPhoto(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const max = 2880;
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  if (long <= max) return img;
  const s = max / long;
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function isCurrent(item) { return state.items.includes(item); }

// Background work (decoding, captions) finished: update, but never under a running export.
function refresh() {
  if (state.exporting) { state.pendingRefresh = true; return; }
  renderItems();
  invalidate();
}

async function videoThumb(v) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 192;
  const ctx = c.getContext('2d');
  const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
  const w = v.videoWidth * s, h = v.videoHeight * s;
  ctx.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
  return c.toDataURL('image/jpeg', 0.7);
}

async function addFile(file) {
  const url = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
  const item = { id: nextId++, file, url, name: file.name, kind: isVideo ? 'video' : 'photo' };
  if (isVideo) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.src = url;
    $('media').appendChild(v);
    try { await waitFor(v, 'loadeddata'); }
    catch (err) { v.remove(); URL.revokeObjectURL(url); throw err; }
    item.el = v;
    item.srcDuration = v.duration;
    item.keepSound = true;
    item.captions = false;
    item.trim = false;
    item.words = null;
    item.audio = undefined; // decoded lazily below
    await new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = Math.min(0.5, v.duration / 2); setTimeout(r, 1500); });
    item.thumb = await videoThumb(v);
    decodeFile(file, 60).then(buf => {
      item.audio = buf;
      if (isCurrent(item)) refresh();
    });
  } else {
    try { item.el = await loadPhoto(url); }
    catch { URL.revokeObjectURL(url); throw new Error('This photo couldn’t be opened'); }
    item.duration = 3;
    item.thumb = url;
  }
  state.items.push(item);
}

$('pick').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  $('media-err').textContent = '';
  const failed = [];
  for (const f of files) {
    try { await addFile(f); }
    catch (err) { failed.push(`${f.name}: ${err.message}`); }
    renderItems();
    invalidate();
  }
  $('media-err').textContent = failed.join('\n');
});

// ---------- item list ----------

function chip(label, pressed, onClick, key) {
  const b = document.createElement('button');
  b.className = 'chip';
  if (key) b.dataset.key = key;
  b.textContent = label;
  b.setAttribute('aria-pressed', String(!!pressed));
  b.addEventListener('click', onClick);
  return b;
}

function renderItems() {
  const ul = $('items');
  const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  ul.innerHTML = '';
  state.items.forEach((item, i) => {
    const li = document.createElement('li');
    li.dataset.id = item.id;
    const img = document.createElement('img');
    img.className = 'thumb'; img.src = item.thumb; img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.kind === 'photo' ? `Photo ${i + 1}` : `Clip ${i + 1}`;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const chips = document.createElement('div');
    chips.className = 'chips';

    if (item.kind === 'photo') {
      sub.textContent = `${item.duration} s on screen`;
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const d of [2, 3, 4, 5]) {
        const b = document.createElement('button');
        b.textContent = `${d}s`;
        b.dataset.key = `${item.id}-d${d}`;
        b.setAttribute('aria-label', `${d} seconds`);
        b.setAttribute('aria-pressed', String(item.duration === d));
        b.addEventListener('click', () => { item.duration = d; renderItems(); invalidate(); });
        seg.appendChild(b);
      }
      chips.appendChild(seg);
    } else {
      const noAudio = item.audio === null;
      const reading = item.audio === undefined;
      sub.textContent = `${formatTime(item.srcDuration)} video` + (noAudio ? ' · no sound' : reading ? ' · reading sound…' : '');
      if (!noAudio) {
        chips.appendChild(chip('Sound', item.keepSound, () => { item.keepSound = !item.keepSound; renderItems(); invalidate(); }, `${item.id}-sound`));
        chips.appendChild(chip('Captions', item.captions, () => toggleSpeech(item, 'captions'), `${item.id}-cap`));
        chips.appendChild(chip('Cut pauses', item.trim, () => toggleSpeech(item, 'trim'), `${item.id}-trim`));
      }
    }
    meta.append(name, sub, chips);
    if (item.status) {
      const st = document.createElement('div');
      st.className = 'status' + (item.statusErr ? ' err' : '');
      st.textContent = item.status;
      meta.appendChild(st);
    }

    const order = document.createElement('div');
    order.className = 'order';
    const label = name.textContent.toLowerCase();
    const up = Object.assign(document.createElement('button'), { textContent: '↑', disabled: i === 0 });
    up.setAttribute('aria-label', `Move ${label} up`);
    up.dataset.key = `${item.id}-up`;
    up.addEventListener('click', () => move(i, -1));
    const down = Object.assign(document.createElement('button'), { textContent: '↓', disabled: i === state.items.length - 1 });
    down.setAttribute('aria-label', `Move ${label} down`);
    down.dataset.key = `${item.id}-down`;
    down.addEventListener('click', () => move(i, 1));
    const del = Object.assign(document.createElement('button'), { textContent: '×' });
    del.setAttribute('aria-label', `Remove ${label}`);
    del.addEventListener('click', () => remove(i));
    order.append(up, down, del);

    li.append(img, meta, order);
    ul.appendChild(li);
  });
  if (focusKey) {
    const el = ul.querySelector(`[data-key="${focusKey}"]`);
    if (el && !el.disabled) el.focus();
  }
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.items.length) return;
  [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
  renderItems(); invalidate();
}

function remove(i) {
  const [item] = state.items.splice(i, 1);
  if (item.kind === 'video') { item.el.pause(); item.el.remove(); }
  URL.revokeObjectURL(item.url);
  renderItems(); invalidate();
}

async function toggleSpeech(item, key) {
  item[key] = !item[key];
  renderItems(); invalidate();
  if (!item[key] || item.words || item.busy) return;
  if (item.audio === undefined) { item.status = 'Reading the clip’s sound…'; renderItems(); }
  item.busy = true;
  const status = s => { item.status = s; if (isCurrent(item) && !state.exporting) renderItems(); };
  try {
    while (item.audio === undefined && isCurrent(item)) await new Promise(r => setTimeout(r, 200));
    if (!isCurrent(item)) return;
    if (!item.audio) throw new Error('This clip has no sound to listen to.');
    item.statusErr = false;
    const words = await transcribe(item.audio, status);
    if (!isCurrent(item)) return; // removed while we were listening
    item.words = words;
    item.status = words.length ? `${words.length} words heard` : 'No speech heard in this clip';
  } catch (err) {
    item.status = `Couldn’t make captions: ${err.message}`;
    item.statusErr = true;
    item.captions = false; item.trim = false;
  } finally {
    item.busy = false;
    if (isCurrent(item)) refresh();
  }
}

// ---------- title & music ----------

$('title').addEventListener('input', () => invalidate(false));
$('subtitle').addEventListener('input', () => invalidate(false));

$('music').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $('music-label').textContent = 'Reading…';
  $('music-err').textContent = '';
  const buffer = await decodeFile(file);
  if (!buffer) { $('music-label').textContent = 'Choose a track'; $('music-err').textContent = 'That audio file couldn’t be read. Try an MP3 or M4A.'; return; }
  state.music = { file, buffer };
  $('music-label').textContent = `${file.name.replace(/\.[^.]+$/, '')} · ${formatTime(buffer.duration)}`;
  $('music-clear').classList.remove('hidden');
  $('music-opts').classList.remove('hidden');
  invalidate();
});
$('music-clear').addEventListener('click', () => {
  state.music = null;
  $('music-label').textContent = 'Choose a track';
  $('music-clear').classList.add('hidden');
  $('music-opts').classList.add('hidden');
  invalidate();
});
$('vol').addEventListener('change', e => { state.musicVolume = Number(e.target.value); invalidate(); });
$('duck').addEventListener('click', e => {
  state.duck = !state.duck;
  e.currentTarget.setAttribute('aria-pressed', String(state.duck));
  invalidate();
});

// ---------- timeline / preview ----------

let stillTimer = null;
function invalidate(soundChanged = true, keepOutput = false) {
  if (state.exporting) { state.pendingRefresh = true; return; } // editor is locked during export anyway
  stopPreview();
  if (soundChanged) state.soundtrack = null;
  if (!keepOutput) clearOutput();
  state.tl = buildTimeline(state.items);
  const { total, truncated, skipped } = state.tl;
  $('len').textContent = total ? `${formatTime(total)} · ${state.items.length} item${state.items.length === 1 ? '' : 's'}` : 'Empty';
  $('truncated').classList.toggle('hidden', !truncated);
  $('skipped').classList.toggle('hidden', !skipped);
  const reading = state.items.some(i => i.kind === 'video' && i.audio === undefined);
  $('play').disabled = !total;
  $('export').disabled = !total || reading;
  $('export-hint').textContent = reading ? 'Reading sound from your clips… one moment.' : '1080 × 1920, ready for Instagram and WhatsApp.';
  clearTimeout(stillTimer);
  stillTimer = setTimeout(drawStill, 120);
  updateDiag();
}

async function drawStill() {
  const ctx = $('preview').getContext('2d');
  const tl = state.tl;
  if (!tl || !tl.total || state.exporting) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1080, 1920); return; }
  const t = Math.min(1.2, tl.total / 2);
  await seekFor(tl, t);
  drawFrame(ctx, tl, t, titles());
}

function titles() {
  return { title: $('title').value.trim(), subtitle: $('subtitle').value.trim() };
}

async function getSoundtrack() {
  if (state.soundtrack && state.soundtrack.tl === state.tl) return state.soundtrack.buffer;
  const tl = state.tl;
  const buffer = await mixSoundtrack(tl, {
    music: state.music && state.music.buffer, musicVolume: state.musicVolume, duck: state.duck,
  });
  // only keep it if nothing changed while mixing
  if (state.tl === tl) state.soundtrack = { tl, buffer };
  return buffer;
}

function stopPreview() {
  if (state.player) { state.player.stop(); state.player = null; $('play').textContent = 'Play'; }
}

$('play').addEventListener('click', async () => {
  if (state.player) { stopPreview(); drawStill(); return; }
  unlockAudio(); // must happen inside the tap on iPhone
  const tl = state.tl;
  const p = new Player($('preview'), tl, null, titles());
  state.player = p; // set before any await, so a second tap means Stop
  $('play').textContent = 'Stop';
  p.onEnd = () => { if (state.player === p) { state.player = null; $('play').textContent = 'Play'; } };
  try {
    const soundtrack = await getSoundtrack();
    if (state.player !== p || state.tl !== tl) return; // stopped or changed meanwhile
    p.soundtrack = soundtrack;
    await p.play(0);
  } catch (err) {
    if (state.player === p) stopPreview();
    $('export-err').textContent = err.message;
  }
});

function unlockAudio() {
  const ac = audioContext();
  if (ac.state !== 'running') ac.resume().catch(() => {});
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // play even with the silent switch on
}

// ---------- export ----------

function clearOutput() {
  if (state.output) { URL.revokeObjectURL(state.output.url); state.output = null; }
  $('result').classList.add('hidden');
  $('out').removeAttribute('src');
  $('export-err').textContent = '';
}

function showError(msg) {
  $('export-err').textContent = msg;
}

function lockEditor(locked) {
  document.querySelectorAll('section:not(#sec-export)').forEach(s => { s.inert = locked; s.classList.toggle('locked', locked); });
}

$('export').addEventListener('click', async () => {
  unlockAudio();
  stopPreview();
  clearOutput();
  const ac = new AbortController();
  state.exporting = ac;
  state.pendingRefresh = false;
  lockEditor(true);
  $('export').disabled = true;
  $('play').disabled = true;
  $('progress-wrap').classList.remove('hidden');
  $('progress').value = 0;
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    $('progress-text').textContent = 'Mixing sound…';
    const soundtrack = await getSoundtrack();
    const method = window.__forceExport || await exportMethod(!!soundtrack);
    $('progress-text').textContent = method === 'realtime' ? 'Recording in real time — keep the app open…' : 'Rendering…';
    const { blob } = await exportReel({
      tl: state.tl, soundtrack, ...titles(), signal: ac.signal, canvas: $('preview'), force: method,
      onProgress: f => { $('progress').value = f; },
    });
    const ext = blob.type.includes('webm') ? 'webm' : 'mp4';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const file = new File([blob], `reel-${stamp}.${ext}`, { type: blob.type });
    state.output = { file, url: URL.createObjectURL(blob), method };
    $('out').src = state.output.url;
    $('result').classList.remove('hidden');
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (err.name !== 'AbortError') showError(`Couldn’t make the video: ${err.message || err}`);
  } finally {
    try { await wake?.release(); } catch {}
    state.exporting = null;
    lockEditor(false);
    $('progress-wrap').classList.add('hidden');
    $('export').disabled = !state.tl?.total;
    $('play').disabled = !state.tl?.total;
    if (state.pendingRefresh) {
      // something finished in the background during the export; keep the video, update the list
      state.pendingRefresh = false;
      renderItems();
      invalidate(true, true);
    }
    updateDiag();
    drawStill();
  }
});

$('cancel').addEventListener('click', () => state.exporting && state.exporting.abort());

$('save').addEventListener('click', async () => {
  const out = state.output;
  if (!out) return;
  const data = { files: [out.file] };
  if (navigator.canShare && navigator.canShare(data)) {
    try { await navigator.share(data); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = Object.assign(document.createElement('a'), { href: out.url, download: out.file.name });
  document.body.appendChild(a); a.click(); a.remove();
});

// ---------- diagnostics ----------

async function updateDiag() {
  const vv = window.visualViewport;
  const method = await exportMethod(true).catch(() => 'error');
  $('diag').textContent = [
    `v${VERSION}`,
    `export: ${method || 'unsupported'}${state.output ? ` · last: ${state.output.method}, ${(state.output.file.size / 1e6).toFixed(1)} MB` : ''}`,
    `innerHeight ${innerHeight} · vv ${vv ? `${Math.round(vv.height)}/${Math.round(vv.offsetTop)}` : 'n/a'} · standalone ${!!navigator.standalone}`,
    `items ${state.items.length} · length ${state.tl ? state.tl.total.toFixed(2) : 0}s`,
    navigator.userAgent,
  ].join('\n');
}

invalidate();
window.__app = { state, invalidate, VERSION };
