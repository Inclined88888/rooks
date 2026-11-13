// The desktop's release check, off the main thread: hashing every daemon file
// takes up to a minute behind an antivirus (TODO #439), and on the main thread
// the app looked frozen. Same function, same verdict: a failure is thrown here
// and reaches the main thread as the worker's `error`, with its message intact.
import { parentPort, workerData } from 'node:worker_threads';
import { verifyRelease } from './release-integrity.mjs';

parentPort.postMessage(verifyRelease(workerData.root, workerData.publicKey));
