/**
 * Synthetic audio shared by the dictation tests. Holds no test of its own:
 * the `.test.ts` suffix keeps it out of dist/ (see tsconfig `exclude`).
 */

export const RATE = 16_000;

/** A 220 Hz tone (RMS ≈ amplitude / √2). */
export function tone(ms: number, amplitude = 0.2): Float32Array {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

/** Deterministic low noise. */
export function hush(ms: number, amplitude = 0.001): Float32Array {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  let seed = 7;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out[i] = amplitude * ((seed / 2147483648) * 2 - 1);
  }
  return out;
}

export function concatAudio(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Splits audio in 100 ms chunks, the size the renderer sends. */
export function chunks(audio: Float32Array): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < audio.length; i += RATE / 10) out.push(audio.slice(i, i + RATE / 10));
  return out;
}

/** Largest absolute sample: the fake recognizers read their "words" from it. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (const v of samples) max = Math.max(max, Math.abs(v));
  return max;
}
