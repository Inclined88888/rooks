/**
 * Receiving a zip from the browser: its bytes are streamed to a temporary file
 * as they arrive, never held whole in memory, and the stream is cut as soon
 * as it passes the ceiling. The file lives in a folder of its own, created
 * with an unguessable name, readable by the daemon's user only; `dispose`
 * removes the folder.
 */
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZIP_UPLOAD_MAX_BYTES } from './limits.js';
import { ReaderError } from './policy.js';

export type StagedUpload = {
  /** The staged archive, to hand to `readZipFile`. */
  path: string;
  size: number;
  dispose(): Promise<void>;
};

export type StageOptions = {
  /** Where the temporary folder is created: a directory of the plugin's own, never a fixed `/tmp`. */
  dir: string;
  /** A lower ceiling than ZIP_UPLOAD_MAX_BYTES; a higher one is ignored. */
  maxBytes?: number;
  /** The announced length (`Content-Length`), when there is one: refused before reading a byte. */
  declaredBytes?: number;
};

export async function stageUpload(source: AsyncIterable<Uint8Array>, options: StageOptions): Promise<StagedUpload> {
  const maxBytes = Math.min(options.maxBytes ?? ZIP_UPLOAD_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES);
  if (options.declaredBytes !== undefined && options.declaredBytes > maxBytes) {
    throw new ReaderError('too-large', `the archive is larger than ${maxBytes} bytes`);
  }
  const folder = await mkdtemp(join(options.dir, 'agent-import-'));
  const dispose = (): Promise<void> => rm(folder, { recursive: true, force: true });
  const path = join(folder, 'source.zip');
  let size = 0;
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of source) {
        size += chunk.length;
        // Leaving the loop also ends the source stream: the rest of the body is not read.
        if (size > maxBytes) throw new ReaderError('too-large', `the archive is larger than ${maxBytes} bytes`);
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
  } catch (err) {
    await dispose();
    throw err;
  }
  return { path, size, dispose };
}
