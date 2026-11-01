// Beat detection for a music track. Pure: works on a Float32Array of samples, no DOM,
// so it runs the same on the iPhone and in node tests.
//
// Method: spectral flux onsets → tempo by autocorrelation (70–180 BPM, gently biased
// toward 90–150 so a 70 BPM ballad isn't read as 140 or vice versa) → beat phase by a
// comb over the onset envelope → the "drop": the strongest onset in a window near
// the start (popular reels put their reveal 2.4–4.1 s in).

const HOP = 512;
const N = 1024;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const k = i + j + len / 2;
        const vr = re[k] * cr - im[k] * ci, vi = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - vr; im[k] = im[i + j] - vi;
        re[i + j] += vr; im[i + j] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Onset strength per hop (half-wave rectified log-spectral flux, local mean removed).
export function onsetEnvelope(samples, sampleRate, maxSeconds = 90) {
  const len = Math.min(samples.length, Math.floor(maxSeconds * sampleRate));
  const frames = Math.max(0, Math.floor((len - N) / HOP));
  const win = new Float32Array(N);
  for (let k = 0; k < N; k++) win[k] = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / N);
  const flux = new Float32Array(frames), lowFlux = new Float32Array(frames);
  const lowBins = Math.max(2, Math.round(250 / (sampleRate / N))); // kick and bass: where the beat lives
  const re = new Float32Array(N), im = new Float32Array(N);
  let prev = null, cur = new Float32Array(N / 2);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let k = 0; k < N; k++) { re[k] = samples[off + k] * win[k]; im[k] = 0; }
    fft(re, im);
    let fl = 0, lo = 0;
    for (let k = 0; k < N / 2; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (prev) { const d = cur[k] - prev[k]; if (d > 0) { fl += d; if (k < lowBins) lo += d; } }
    }
    flux[f] = fl; lowFlux[f] = lo;
    const t = prev || new Float32Array(N / 2); prev = cur; cur = t;
  }
  const detrend = src => {
    const out = new Float32Array(frames), R = 8;
    for (let f = 0; f < frames; f++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, f - R); k < Math.min(frames, f + R + 1); k++) { s += src[k]; c++; }
      out[f] = Math.max(0, src[f] - s / c);
    }
    return out;
  };
  const env = detrend(flux), low = detrend(lowFlux);
  // beat envelope: all onsets plus the low band, weighted equal in total, so the kick
  // wins over hi-hats on the off-beat when picking the phase and the drop
  let se = 0, sl = 0;
  for (let f = 0; f < frames; f++) { se += env[f]; sl += low[f]; }
  const beat = new Float32Array(frames);
  const w = sl > 1e-9 ? se / sl : 0;
  for (let f = 0; f < frames; f++) beat[f] = env[f] + 2 * w * low[f];
  return { env, beat, fps: sampleRate / HOP };
}

// Interpolated envelope value at time t (seconds).
function at(env, fps, t) {
  const x = t * fps, i = Math.floor(x), fr = x - i;
  if (i < 0 || i + 1 >= env.length) return 0;
  return env[i] * (1 - fr) + env[i + 1] * fr;
}

export function estimateTempo(env, fps, lo = 70, hi = 180) {
  let best = -1, bpm = 120;
  for (let b = lo; b <= hi; b += 0.5) {
    const lag = 60 * fps / b;
    let s = 0;
    for (let f = 0; f + lag + 1 < env.length; f++) {
      const l = Math.floor(f + lag), fr = f + lag - l;
      s += env[f] * (env[l] * (1 - fr) + env[l + 1] * fr);
    }
    // the same pulse also scores at half and double tempo; nudge toward the usual reel range
    const bias = b >= 90 && b <= 150 ? 1.0 : 0.9;
    s *= bias;
    if (s > best) { best = s; bpm = b; }
  }
  return bpm;
}

// Returns { bpm, period, phase, drop, confident } — beats are phase + k * period.
export function detectBeats(samples, sampleRate, opts = {}) {
  const { env, beat, fps } = onsetEnvelope(samples, sampleRate, opts.maxSeconds ?? 90);
  const duration = samples.length / sampleRate;
  let energy = 0;
  for (let i = 0; i < env.length; i++) energy += env[i];
  if (env.length < fps * 2 || energy <= 1e-6) return fallbackBeats(duration);

  // coarse tempo from autocorrelation, then refined: the comb that best fits the whole
  // track pins the period far more precisely than the autocorrelation lag can
  const coarse = estimateTempo(env, fps);
  const seconds = env.length / fps;
  const comb = (period) => {
    let best = -1, phase = 0, total = 0, n = 0;
    for (let ph = 0; ph < period; ph += 0.005) {
      let s = 0;
      for (let t = ph; t < seconds; t += period) s += at(beat, fps, t);
      if (s > best) { best = s; phase = ph; }
      total += s; n++;
    }
    return { best, phase, mean: total / n };
  };
  let bpm = coarse, fit = comb(60 / coarse);
  for (let b = coarse - 3; b <= coarse + 3 + 1e-9; b += 0.1) {
    const c = comb(60 / b);
    if (c.best > fit.best) { fit = c; bpm = Math.round(b * 10) / 10; }
  }
  const period = 60 / bpm;
  // a frame's flux describes the middle of its window, not its start
  const lag = N / 2 / sampleRate;
  const phase = (fit.phase + lag) % period, bestScore = fit.best;
  const confident = bestScore > 1.5 * fit.mean;

  // drop: the beat between dropMin and dropMax where the music gets loudest relative
  // to the two beats before it (a log-spectral onset can't see a loudness jump)
  const dropMin = opts.dropMin ?? 2.4, dropMax = opts.dropMax ?? 5.5;
  const rms = (t0, t1) => {
    const i0 = Math.max(0, Math.floor(t0 * sampleRate)), i1 = Math.min(samples.length, Math.floor(t1 * sampleRate));
    let e = 0;
    for (let i = i0; i < i1; i += 4) e += samples[i] * samples[i];
    return Math.sqrt(e / Math.max(1, (i1 - i0) / 4));
  };
  let drop = null, bestJump = 0;
  for (let k = Math.ceil((dropMin - phase) / period); phase + k * period <= dropMax; k++) {
    const g = phase + k * period;
    if (g - 2 * period < 0 || g + period > duration) continue;
    const jump = rms(g, g + period) / (rms(g - 2 * period, g) + 1e-6);
    if (jump > bestJump) { bestJump = jump; drop = g; }
  }
  if (drop == null || bestJump < 1.15) drop = snapToGrid(3, phase, period); // no clear drop: about 3 s in
  if (drop < dropMin - period / 2) drop += period;
  return { bpm, period, phase, drop, confident, duration };
}

// No music (or silence): a steady 120 BPM grid so cuts still feel rhythmic.
export function fallbackBeats(duration = Infinity) {
  return { bpm: 120, period: 0.5, phase: 0, drop: 3, confident: false, duration };
}

export function snapToGrid(t, phase, period) {
  return phase + Math.round((t - phase) / period) * period;
}
