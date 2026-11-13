import { DICTATION_SAMPLE_RATE, MAX_FEED_SAMPLES } from './contract';

/**
 * Microphone PCM → what the local engine accepts: 16 kHz mono Float32 in
 * [-1, 1], in chunks of at most 2 s.
 *
 * The AudioContext runs at the device rate (44.1 or 48 kHz almost always).
 * Asking the context for 16 kHz directly would push the resampling into
 * Chromium, but whether a MediaStream source accepts a context at another
 * rate has varied across engines; doing it here keeps one behaviour on every
 * OS and makes it testable.
 */

/**
 * Streaming box-filter resampler: each output sample is the mean of the input
 * it covers, fractional edges weighted. The mean is the anti-aliasing filter
 * (crude, but speech sits well below 8 kHz and the recognizer works on mel
 * features); it carries its state across `push` calls, so chunk boundaries
 * leave no seam.
 */
export class Resampler {
  /** Input samples per output sample. */
  private readonly ratio: number;
  private acc = 0;
  private remaining: number;

  constructor(readonly inputRate: number, readonly outputRate: number = DICTATION_SAMPLE_RATE) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('sample rates must be positive');
    this.ratio = inputRate / outputRate;
    this.remaining = this.ratio;
  }

  push(input: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return clamp(Float32Array.from(input));
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 1) {
      const x = input[i] ?? 0;
      let weight = 1;
      while (weight > 1e-9) {
        const take = Math.min(weight, this.remaining);
        this.acc += x * take;
        this.remaining -= take;
        weight -= take;
        if (this.remaining <= 1e-9) {
          out.push(this.acc / this.ratio);
          this.acc = 0;
          this.remaining = this.ratio;
        }
      }
    }
    return clamp(Float32Array.from(out));
  }
}

function clamp(samples: Float32Array): Float32Array {
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] ?? 0;
    samples[i] = v > 1 ? 1 : v < -1 ? -1 : Number.isFinite(v) ? v : 0;
  }
  return samples;
}

/** 100 ms of 16 kHz audio: the chunk size docs/DICTATION.md recommends. */
export const FEED_CHUNK_SAMPLES = DICTATION_SAMPLE_RATE / 10;

/** Groups resampled audio into fixed chunks for `feed`. */
export class Chunker {
  private pending: number[] = [];

  constructor(private readonly size: number = FEED_CHUNK_SAMPLES) {
    if (size < 1 || size > MAX_FEED_SAMPLES) throw new Error('chunk size out of the feed bounds');
  }

  push(samples: Float32Array): Float32Array[] {
    for (let i = 0; i < samples.length; i += 1) this.pending.push(samples[i] ?? 0);
    const chunks: Float32Array[] = [];
    while (this.pending.length >= this.size) chunks.push(Float32Array.from(this.pending.splice(0, this.size)));
    return chunks;
  }

  /** What is left, shorter than a chunk; null when nothing is. */
  flush(): Float32Array | null {
    if (this.pending.length === 0) return null;
    const rest = Float32Array.from(this.pending);
    this.pending = [];
    return rest;
  }
}
