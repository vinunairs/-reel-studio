// On-device speech-to-text with Whisper (transformers.js). The model downloads
// once (~40 MB) and is cached by the browser; the audio never leaves the phone.
import { toMono16k } from './audio.js';

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MODEL = 'Xenova/whisper-tiny.en';

let pipePromise = null;

// Tests (and anyone offline) can swap the transcriber: window.__transcribe = async (float32) => words
function loadPipeline(onStatus) {
  if (!pipePromise) {
    pipePromise = (async () => {
      onStatus && onStatus('Downloading speech model (one time, ~40 MB)…');
      const { pipeline } = await import(/* @vite-ignore */ LIB);
      return pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8', device: 'wasm' });
    })().catch(e => { pipePromise = null; throw e; });
  }
  return pipePromise;
}

// Returns [{ text, start, end }] in seconds, from a decoded AudioBuffer.
export async function transcribe(audioBuffer, onStatus) {
  const pcm = await toMono16k(audioBuffer);
  if (typeof window.__transcribe === 'function') return window.__transcribe(pcm);
  const asr = await loadPipeline(onStatus);
  onStatus && onStatus('Listening…');
  const out = await asr(pcm, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
  return (out.chunks || [])
    .map(c => ({ text: String(c.text || '').trim(), start: c.timestamp?.[0], end: c.timestamp?.[1] }))
    .filter(w => w.text && Number.isFinite(w.start))
    .map(w => ({ ...w, end: Number.isFinite(w.end) ? w.end : w.start + 0.3 }));
}
