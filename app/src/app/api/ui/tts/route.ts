export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTS_URL = process.env.TTS_URL ?? 'http://tts:5000';

/**
 * The default synthesis voice, picked by ear among the five tried.
 *
 * It is set here rather than on the client: it is a trait of the TTS
 * service, not of an agent. The other models stay in
 * `~/.rooks/tts/voices` — switching is done by editing these two constants,
 * without touching the interface.
 *
 * `fr_FR-upmc-medium` holds two speakers (jessica, pierre): without naming
 * one, piper would fall back to the one at index 0.
 */
const VOIX_DEFAUT = 'fr_FR-upmc-medium';
const LOCUTEUR_DEFAUT = 'pierre';

/** Beyond this, it is no longer a sentence to speak but a document: truncate
 *  rather than keep the model busy for a minute. */
const MAX_CARACTERES = 800;

/**
 * Local speech synthesis through piper.
 *
 * The browser sends a sentence and gets a WAV back. Nothing leaves the machine:
 * piper is an ONNX model run by the compose's `tts` service, and it replaces
 * the Web Speech API, whose voice catalogue varies from one browser and one
 * machine to the next with nothing we can guarantee.
 */
export async function POST(req: Request): Promise<Response> {
  let texte: string;
  try {
    const body = (await req.json()) as { text?: unknown };
    texte = typeof body.text === 'string' ? body.text.trim() : '';
  } catch {
    return Response.json({ error: 'corps JSON invalide' }, { status: 400 });
  }

  if (!texte) return Response.json({ error: 'texte vide' }, { status: 400 });
  if (texte.length > MAX_CARACTERES) texte = texte.slice(0, MAX_CARACTERES);

  try {
    const r = await fetch(`${TTS_URL}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: texte,
        voice: VOIX_DEFAUT,
        speaker: LOCUTEUR_DEFAUT,
      }),
    });
    if (!r.ok) {
      return Response.json({ error: `piper ${r.status}` }, { status: 502 });
    }
    const wav = await r.arrayBuffer();
    return new Response(wav, {
      headers: {
        'content-type': 'audio/wav',
        // The same sentence comes out identical: the cache avoids synthesising
        // it again when a subtitle is replayed.
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }
}
