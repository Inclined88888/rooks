/**
 * The built-in notification sounds, synthesized rather than shipped as files:
 * no third-party licence to track, no binary of unknown origin in the package,
 * nothing to fetch before the first sound, and a sound is re-tuned by editing
 * a number. They are original to Timon (public domain, CC0).
 */
import type { SoundId } from './notification-sounds';

type Tone = {
  /** Hz. */
  freq: number;
  /** Start, seconds. */
  at: number;
  /** Length, seconds. */
  len: number;
  gain: number;
  /** Exponential decay rate, 1/s. */
  decay: number;
  /** [frequency multiple, weight]. */
  harmonics?: ReadonlyArray<readonly [number, number]>;
};

type Recipe = { len: number; parts: readonly Tone[] };

const RECIPES: Readonly<Record<SoundId, Recipe>> = {
  // Two rising notes, soft: something finished well.
  chime: { len: 0.75, parts: [
    { freq: 784, at: 0, len: 0.5, gain: 0.32, decay: 7, harmonics: [[1, 1], [2, 0.25]] },
    { freq: 1175, at: 0.14, len: 0.6, gain: 0.3, decay: 6, harmonics: [[1, 1], [2, 0.2]] },
  ] },
  // A struck bell with inharmonic partials.
  bell: { len: 1.1, parts: [
    { freq: 880, at: 0, len: 1.1, gain: 0.35, decay: 4, harmonics: [[1, 1], [2.76, 0.35], [5.4, 0.12]] },
  ] },
  // A short, round blip.
  pop: { len: 0.2, parts: [
    { freq: 660, at: 0, len: 0.18, gain: 0.45, decay: 22, harmonics: [[1, 1], [1.5, 0.3]] },
  ] },
  // One clear, high note.
  ping: { len: 0.5, parts: [
    { freq: 1568, at: 0, len: 0.5, gain: 0.3, decay: 9, harmonics: [[1, 1], [2, 0.15]] },
  ] },
  // Three rising notes: something waits for you.
  rise: { len: 0.7, parts: [
    { freq: 659, at: 0, len: 0.22, gain: 0.3, decay: 10 },
    { freq: 880, at: 0.12, len: 0.22, gain: 0.3, decay: 10 },
    { freq: 1319, at: 0.24, len: 0.45, gain: 0.3, decay: 7, harmonics: [[1, 1], [2, 0.2]] },
  ] },
  // Two falling notes, lower: something stopped.
  fall: { len: 0.7, parts: [
    { freq: 622, at: 0, len: 0.3, gain: 0.34, decay: 8, harmonics: [[1, 1], [2, 0.2]] },
    { freq: 415, at: 0.16, len: 0.5, gain: 0.34, decay: 6, harmonics: [[1, 1], [2, 0.2]] },
  ] },
};

const ATTACK_S = 0.004;

/** Mono samples in [-1, 1] at `rate` Hz. */
export function renderSound(id: SoundId, rate: number): Float32Array {
  const recipe = RECIPES[id];
  const out = new Float32Array(Math.floor(recipe.len * rate));
  const attack = Math.max(1, Math.floor(ATTACK_S * rate));
  for (const part of recipe.parts) {
    const start = Math.floor(part.at * rate);
    const count = Math.floor(part.len * rate);
    const harmonics = part.harmonics ?? [[1, 1]];
    for (let i = 0; i < count && start + i < out.length; i += 1) {
      const t = i / rate;
      // Ramps at both ends: a sine started or cut at full level clicks.
      const env = Math.min(1, i / attack) * Math.min(1, (count - i) / attack) * Math.exp(-part.decay * t);
      let sample = 0;
      for (const [mult, weight] of harmonics) sample += weight * Math.sin(2 * Math.PI * part.freq * mult * t);
      out[start + i] = (out[start + i] ?? 0) + part.gain * env * sample;
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i] ?? 0));
  return out;
}
