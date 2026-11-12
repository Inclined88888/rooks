/**
 * Utility process entry of local dictation (TODO #443).
 *
 * Why a utility process and not a worker thread: the recognizer is a native
 * addon, and a crash inside it (segfault, ONNX abort) takes down its whole
 * process. Here that is this process alone; the main process sees an `exit`
 * and reports the session as failed.
 *
 * `.mts` so the entry is ESM by its own extension, whatever package.json the
 * loader finds around it inside the archive.
 */
import type { WorkerOutput } from './speech-protocol.js';
import { createWorkerHandler } from './speech-session.js';
import { sherpaRecognizer } from './speech-sherpa.js';

const port = process.parentPort;

function send(message: WorkerOutput): void {
  port.postMessage(message);
}

const handle = createWorkerHandler({ makeRecognizer: sherpaRecognizer, send });
port.on('message', (event) => handle(event.data));
