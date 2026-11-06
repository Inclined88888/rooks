/**
 * Rebuilds the dictated text from the results of the Web Speech API.
 *
 * The API contract is not honoured the same way everywhere. Desktop Chrome
 * delivers DISJOINT segments and moves `resultIndex` forward; several Android
 * engines (and the PWA of 24/08) instead re-emit, on every event, the WHOLE
 * current sentence — sometimes marked `isFinal` — from index 0. A plain
 * `buffer += transcript` then produces nested copies:
 *
 *   "ok / ok I / ok I am / … / ok I am doing a new voice test"
 *
 * sent as is to the agent, which receives the same sentence thirteen times.
 *
 * Hence this merge: the segments are REBUILT on every event from
 * `event.results`, never accumulated, and a segment that extends what precedes
 * replaces it instead of being appended. Both engine behaviours give the same
 * final text, each word once.
 */

/** Comparison ignoring case, accents and punctuation: an engine adds
 *  punctuation and capitals as it goes, "ok I" then "OK, I am" are indeed the
 *  same sentence start. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Number of words shared by the end of `avant` and the start of `apres`. */
function chevauchement(avant: string[], apres: string[]): number {
  const max = Math.min(avant.length, apres.length);
  for (let k = max; k >= 2; k -= 1) {
    let egal = true;
    for (let i = 0; i < k; i += 1) {
      if (avant[avant.length - k + i] !== apres[i]) {
        egal = false;
        break;
      }
    }
    if (egal) return k;
  }
  return 0;
}

/**
 * Joins transcription segments into a text where each word appears only once.
 * Empty entries are ignored; the order is kept.
 */
export function fusionnerSegments(segments: Array<string | null | undefined>): string {
  let sortie = '';
  let normale = '';

  for (const brut of segments) {
    const seg = (brut ?? '').trim();
    if (!seg) continue;
    const n = normaliser(seg);
    if (!n) continue;

    if (!normale) {
      sortie = seg;
      normale = n;
      continue;
    }
    // Rewrite: the engine delivers again everything it already said, longer.
    if (n.startsWith(normale)) {
      sortie = seg;
      normale = n;
      continue;
    }
    // Segment already fully transcribed (identical redelivery).
    if (normale.endsWith(n)) continue;

    // Partial overlap: append only the new tail.
    const motsA = normale.split(' ');
    const motsB = n.split(' ');
    const k = chevauchement(motsA, motsB);
    if (k > 0) {
      const inedit = seg.trim().split(/\s+/).slice(k).join(' ');
      if (!inedit) continue;
      sortie = `${sortie} ${inedit}`;
      normale = `${normale} ${motsB.slice(k).join(' ')}`;
      continue;
    }

    sortie = `${sortie} ${seg}`;
    normale = `${normale} ${n}`;
  }

  return sortie;
}

type ResultatBrut = { 0: { transcript: string }; isFinal: boolean };

/**
 * Reads ALL of `results` (never from `resultIndex`: the engines that rewrite
 * the sentence leave it at 0 and the rest would be lost) and returns the final
 * and the interim text of the current session.
 */
export function lireResultats(results: ArrayLike<ResultatBrut>): {
  final: string;
  interim: string;
} {
  const finals: string[] = [];
  const interims: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    if (!r) continue;
    const t = r[0]?.transcript ?? '';
    if (!t.trim()) continue;
    (r.isFinal ? finals : interims).push(t);
  }
  return { final: fusionnerSegments(finals), interim: fusionnerSegments(interims) };
}
