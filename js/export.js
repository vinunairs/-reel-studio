// Turns a timeline into an MP4.
// Fast path: WebCodecs (H.264 + AAC) rendered frame by frame, muxed with mp4-muxer.
// Fallback: play the reel in real time and record it with MediaRecorder.
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';
import { FPS, WIDTH, HEIGHT } from './timeline.js';
import { drawFrame, seekFor } from './render.js';
import { Player, audioContext } from './player.js';
import { RATE } from './audio.js';

const VIDEO_CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028'];

export async function pickVideoConfig() {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of VIDEO_CODECS) {
    const config = { codec, width: WIDTH, height: HEIGHT, bitrate: 8_000_000, framerate: FPS, avc: { format: 'avc' } };
    try {
      const r = await VideoEncoder.isConfigSupported(config);
      if (r.supported) return r.config;
    } catch {}
  }
  return null;
}

export async function pickAudioConfig() {
  if (typeof AudioEncoder === 'undefined') return null;
  // tests in Chromium (no AAC encoder) can set window.__testAudioCodec = 'opus'
  const codec = (typeof window !== 'undefined' && window.__testAudioCodec) || 'mp4a.40.2';
  const config = { codec, sampleRate: RATE, numberOfChannels: 2, bitrate: 128_000 };
  try {
    const r = await AudioEncoder.isConfigSupported(config);
    return r.supported ? r.config : null;
  } catch { return null; }
}

// Which export method will be used on this device, without starting anything.
export async function exportMethod(needsAudio) {
  const v = await pickVideoConfig();
  if (v && (!needsAudio || await pickAudioConfig())) return 'webcodecs';
  if (typeof MediaRecorder !== 'undefined') return 'realtime';
  return null;
}

// args: { tl, soundtrack, title, subtitle, onProgress(fraction), signal, force }
export async function exportReel(args) {
  const method = args.force || await exportMethod(!!args.soundtrack);
  if (method === 'webcodecs') return { blob: await exportWebCodecs(args), method };
  if (method === 'realtime') return { blob: await exportRealtime(args), method };
  throw new Error('This browser can’t make videos. Update iOS and try again.');
}

async function exportWebCodecs({ tl, soundtrack, title, subtitle, onProgress, signal }) {
  const vConfig = await pickVideoConfig();
  const aConfig = soundtrack ? await pickAudioConfig() : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: WIDTH, height: HEIGHT, frameRate: FPS },
    audio: aConfig ? { codec: aConfig.codec === 'opus' ? 'opus' : 'aac', numberOfChannels: 2, sampleRate: RATE } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { failure = e; },
  });
  venc.configure(vConfig);

  // audio first: it's quick and shows up encoder problems early
  if (aConfig) {
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: e => { failure = e; },
    });
    aenc.configure(aConfig);
    const L = soundtrack.getChannelData(0);
    const R = soundtrack.numberOfChannels > 1 ? soundtrack.getChannelData(1) : L;
    const block = 4800; // 0.1 s
    for (let i = 0; i < L.length; i += block) {
      const n = Math.min(block, L.length - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0);
      data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / RATE * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
    aenc.close();
  }

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const frames = Math.max(1, Math.round(tl.total * FPS));
  const opts = { title, subtitle };
  for (let i = 0; i < frames; i++) {
    if (signal && signal.aborted) { venc.close(); throw new DOMException('Cancelled', 'AbortError'); }
    if (failure) throw failure;
    const t = i / FPS;
    await seekFor(tl, t);
    drawFrame(ctx, tl, t, opts);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
    venc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
    if (i % 10 === 0) onProgress && onProgress(i / frames);
  }
  await venc.flush();
  if (failure) throw failure;
  venc.close();
  muxer.finalize();
  onProgress && onProgress(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

function recorderType() {
  const types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function exportRealtime({ tl, soundtrack, title, subtitle, onProgress, signal, canvas }) {
  const c = canvas || Object.assign(document.createElement('canvas'), { width: WIDTH, height: HEIGHT });
  const stream = c.captureStream(FPS);
  let dest = null;
  if (soundtrack) {
    dest = audioContext().createMediaStreamDestination();
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  }
  const type = recorderType();
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const player = new Player(c, tl, soundtrack, { title, subtitle });
  const done = new Promise((resolve, reject) => {
    rec.onstop = () => resolve();
    rec.onerror = e => reject(e.error || new Error('Recording failed'));
    player.onEnd = () => setTimeout(() => rec.state !== 'inactive' && rec.stop(), 200);
    player.onTime = t => onProgress && onProgress(t / tl.total);
    if (signal) signal.addEventListener('abort', () => { player.stop(); rec.state !== 'inactive' && rec.stop(); });
  });
  rec.start(1000);
  await player.play(0, dest);
  await done;
  if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  onProgress && onProgress(1);
  return new Blob(chunks, { type: (type || 'video/mp4').split(';')[0] });
}
