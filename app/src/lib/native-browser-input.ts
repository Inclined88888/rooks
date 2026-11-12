export type RemoteInput = Record<string, unknown> & { type: string };

/** Keep button/key ordering while collapsing moves still waiting for the network. */
export function browserInputQueue(send: (input: RemoteInput) => Promise<unknown>, onError: (error: unknown) => void) {
  let queue: RemoteInput[] = [];
  let draining = false;
  let cancelled = false;
  async function drain() {
    if (draining || cancelled) return;
    draining = true;
    try {
      while (queue.length && !cancelled) await send(queue.shift()!);
    } catch (error) { queue = []; if (!cancelled) onError(error); }
    finally { draining = false; }
  }
  return {
    push(input: RemoteInput) {
      if (cancelled) return;
      const previous = queue.at(-1);
      if (input.type === 'move' && previous?.type === 'move') queue[queue.length - 1] = input;
      else if (input.type === 'wheel' && previous?.type === 'wheel') queue[queue.length - 1] = { ...input, deltaX: Number(previous.deltaX ?? 0) + Number(input.deltaX ?? 0), deltaY: Number(previous.deltaY ?? 0) + Number(input.deltaY ?? 0) };
      else queue.push(input);
      void drain();
    },
    cancel() { cancelled = true; queue = []; },
  };
}

export function mouseButton(button: number): 'left' | 'middle' | 'right' { return button === 2 ? 'right' : button === 1 ? 'middle' : 'left'; }

export type ClipboardKind = 'copy' | 'cut' | 'paste';

/**
 * The OS clipboard gestures. They must reach the browser untouched: only the DOM
 * copy/cut/paste events they raise carry the clipboard without any permission prompt.
 * Alt is excluded so an AltGr layout key is not mistaken for Ctrl+<letter>.
 */
export function clipboardShortcut(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): ClipboardKind | null {
  const key = event.key.toLowerCase();
  if (event.altKey) return null;
  if (event.ctrlKey || event.metaKey) {
    if (key === 'c') return 'copy';
    if (key === 'x') return 'cut';
    if (key === 'v') return 'paste';
    if (key === 'insert' && event.ctrlKey && !event.shiftKey) return 'copy';
  }
  if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
    if (key === 'insert') return 'paste';
    if (key === 'delete') return 'cut';
  }
  return null;
}

/** File bytes travel only through the selected profile's authenticated commands. */
export async function uploadBrowserFiles(files: File[], chooserId: string, command: <T>(action: string, data: Record<string, unknown>) => Promise<T>, progress: (done: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  if (!files.length || files.length > 20) throw new Error('Choose between 1 and 20 files.');
  if (files.some((file) => file.size > 100 * 1024 * 1024)) throw new Error('Each file must be at most 100 MiB.');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let done = 0;
  const uploadIds: string[] = [];
  const check = () => { if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError'); };
  for (const file of files) {
    check();
    const upload = await command<{ uploadId: string }>('fileUploadBegin', { chooserId, name: file.name, size: file.size });
    uploadIds.push(upload.uploadId);
    for (let offset = 0; offset < file.size;) {
      check();
      const bytes = new Uint8Array(await file.slice(offset, offset + 128 * 1024).arrayBuffer());
      const data = bytesToBase64(bytes);
      const result = await command<{ offset: number }>('fileUploadChunk', { uploadId: upload.uploadId, offset, data });
      if (result.offset !== offset + bytes.length) throw new Error('Upload offset mismatch.');
      offset = result.offset; done += bytes.length; progress(done, total);
    }
  }
  check();
  await command('fileUploadCommit', { chooserId, uploadIds });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
