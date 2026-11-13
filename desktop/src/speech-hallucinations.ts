/**
 * Drops what an ASR model invents on silence or noise (TODO #443).
 *
 * Whisper-family and, less often, Parakeet models trained on subtitled video
 * "hear" subtitle credits and sign-offs in near-silence, and loop on a word
 * when the audio gives them nothing to hold on to. The segmenter already
 * refuses to decode audio without speech energy; this is the second net, on
 * the text, with what the audio looked like.
 */

/**
 * The anti-hallucination profiles a catalog entry may name (`filter`). Each
 * is code: an entry chooses one by name, it never brings its own patterns.
 */
export const HALLUCINATION_PROFILES = ['nemo', 'whisper-like', 'cohere'] as const;
export type HallucinationProfile = typeof HALLUCINATION_PROFILES[number];

export type SegmentStats = {
  /** Duration of the frames above the speech threshold. */
  voicedMs: number;
  totalMs: number;
};

/** Lowercase, accents and punctuation removed, single spaces. */
export function normalizeTranscript(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Subtitle credits and channel sign-offs: nobody dictates them, drop them whatever the audio. */
const ALWAYS_PHANTOM: readonly RegExp[] = [
  /^sous titr(e|es|age) (realises? |faits? )?par( \w+){1,6}$/,
  /^sous titrage st \d+$/,
  /\bamara org\b/,
  /^(thanks|thank you) (so much )?for watching$/,
  /^merci d avoir regarde( cette video)?$/,
  /^(please )?(like and )?subscribe( to (my|our|the) channel)?$/,
  /^(n oubliez pas de vous abonner|abonnez vous)( a (la|ma|notre) chaine)?$/,
];

/**
 * Subtitle credits that Whisper-like and Cohere decoders write on silence,
 * breath or noise, normalized. Cohere never returns an empty text and cuts
 * the end of what it says (`Sous-titrage Société Radio-`), so these match by
 * prefix, in both directions: a text that starts with one of them, or a text
 * that is the beginning of one (long enough not to be a real word).
 * Measured on Cohere Transcribe (TODO #484):
 * `Sous-titrage Société Radio-Canada` on 2 s of silence, of white noise and of a pure tone.
 */
const SUBTITLE_PHANTOMS: readonly string[] = [
  'sous titrage societe radio canada',
  'sous titres realises par la communaute d amara org',
  'sous titres realises para la communaute d amara org',
  'merci d avoir regarde cette video',
  'thank you for watching',
  'thanks for watching',
];
/** A text starting with one of these is a credit, whatever follows. */
const PHANTOM_HEADS: readonly string[] = ['sous titrage', 'merci d avoir regarde', 'thank you for watching', 'thanks for watching'];
/**
 * Credits a cut text may be the beginning of: only those with a head, so that
 * "sous titres" alone, a dictable phrase, never matches by its start.
 */
const CUT_CREDITS: readonly string[] = SUBTITLE_PHANTOMS.filter((phantom) => PHANTOM_HEADS.some((head) => phantom.startsWith(head)));
/** A shorter cut ("merci", "sous") is a real word as often as a credit. */
const MIN_CUT_LENGTH = 8;

function isCutPhantom(normalized: string): boolean {
  if (PHANTOM_HEADS.some((head) => normalized === head || normalized.startsWith(`${head} `))) return true;
  // A courtesy word ("thank you") is also the start of a credit: the
  // weak-segment rule decides it, not the prefix.
  if (normalized.length < MIN_CUT_LENGTH || WEAK_PHANTOM.has(normalized)) return false;
  return CUT_CREDITS.some((phantom) => phantom.startsWith(normalized));
}

type ProfileRules = {
  /** Credits matched by prefix, for decoders that cut their output. */
  cutPhantoms: boolean;
};

const PROFILES: Readonly<Record<HallucinationProfile, ProfileRules>> = {
  // Parakeet and Canary return nothing on silence: exact matches are enough,
  // and `Sous-titrage de la vidéo` stays a sentence one can dictate.
  nemo: { cutPhantoms: false },
  'whisper-like': { cutPhantoms: true },
  cohere: { cutPhantoms: true },
};

/**
 * Courtesy words that are real when spoken and invented on a breath or a
 * click: dropped only when the segment carried little voiced audio.
 */
const WEAK_PHANTOM = new Set([
  'thank you', 'thanks', 'thank you very much', 'you', 'bye', 'bye bye', 'merci', 'merci beaucoup',
  'au revoir', 'music', 'musique', 'applause', 'applaudissements', 'hmm', 'mm', 'uh', 'um', 'euh', 'ah', 'oh',
]);
const WEAK_VOICED_MS = 600;

/** Non-speech tags some models emit: `[Music]`, `(applause)`, `*rires*`. */
const TAG = /[[(*♪]\s*(music|musique|applause|applaudissements|laughter|rires?|silence|bruit|noise|inaudible|blank_audio)\s*[\])*♪]/giu;

/**
 * Collapses an n-gram (1 to 4 words) repeated back to back: a run of 4 single
 * words, or 3 of a longer group, is a decoding loop, not speech ("very very
 * very" survives). Original words and casing are kept.
 */
export function collapseRepeats(words: readonly string[]): string[] {
  const norm = words.map((w) => normalizeTranscript(w));
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 4; n >= 1 && !collapsed; n -= 1) {
      const minRuns = n === 1 ? 4 : 3;
      if (i + n * minRuns > words.length) continue;
      const gram = norm.slice(i, i + n).join(' ');
      if (gram === '') continue;
      let runs = 1;
      while (i + (runs + 1) * n <= words.length && norm.slice(i + runs * n, i + (runs + 1) * n).join(' ') === gram) runs += 1;
      if (runs >= minRuns) {
        out.push(...words.slice(i, i + n));
        i += runs * n;
        collapsed = true;
      }
    }
    if (!collapsed) {
      out.push(words[i] as string);
      i += 1;
    }
  }
  return out;
}

/** The text to keep for a decoded segment, or null when it is an invention. */
export function cleanTranscript(text: string, stats: SegmentStats, profile: HallucinationProfile = 'nemo'): string | null {
  const untagged = text.replace(TAG, ' ').replace(/\s+/g, ' ').trim();
  if (untagged === '') return null;
  const normalized = normalizeTranscript(untagged);
  if (normalized === '') return null;
  if (ALWAYS_PHANTOM.some((re) => re.test(normalized))) return null;
  if (PROFILES[profile].cutPhantoms && isCutPhantom(normalized)) return null;
  if (stats.voicedMs < WEAK_VOICED_MS && WEAK_PHANTOM.has(normalized)) return null;
  const words = collapseRepeats(untagged.split(' '));
  const kept = words.join(' ').trim();
  return kept === '' ? null : kept;
}
