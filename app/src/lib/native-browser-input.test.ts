import assert from 'node:assert/strict';
import test from 'node:test';
import { browserInputQueue, clipboardShortcut, uploadBrowserFiles, type RemoteInput } from './native-browser-input';

test('remote drag preserves down/up order, coalesces pending moves, and cancels stale input', async () => {
  const sent: RemoteInput[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = browserInputQueue(async (event) => { sent.push(event); if (sent.length === 1) await gate; }, (error) => { throw error; });
  queue.push({ type: 'down', x: 1, y: 1, button: 'left' });
  queue.push({ type: 'move', x: 2, y: 2, buttons: 1 });
  queue.push({ type: 'move', x: 80, y: 40, buttons: 1 });
  queue.push({ type: 'up', x: 80, y: 40, button: 'left' });
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((item) => item.type), ['down', 'move', 'up']);
  assert.equal(sent[1]?.x, 80);
  queue.cancel(); queue.push({ type: 'text', text: 'must not enter a new profile' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3);
});

test('file upload preserves bytes and commits only acknowledged chunks for the chooser', async () => {
  const bytes = new Uint8Array(270_123).map((_, index) => index % 251);
  const file = new File([bytes], 'client.txt');
  const chunks: Buffer[] = [];
  let offset = 0;
  let committed: unknown;
  let progress = 0;
  await uploadBrowserFiles([file], 'chooser-one', async <T>(action: string, data: Record<string, unknown>) => {
    if (action === 'fileUploadBegin') { assert.deepEqual(data, { chooserId: 'chooser-one', name: 'client.txt', size: file.size }); return { uploadId: 'upload-one' } as T; }
    if (action === 'fileUploadChunk') {
      assert.equal(data.offset, offset); assert.equal(data.uploadId, 'upload-one');
      const chunk = Buffer.from(String(data.data), 'base64'); assert.ok(chunk.length <= 131072); chunks.push(chunk); offset += chunk.length;
      return { offset } as T;
    }
    assert.equal(action, 'fileUploadCommit'); committed = data; return {} as T;
  }, (done) => { progress = done; });
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
  assert.equal(progress, file.size);
  assert.deepEqual(committed, { chooserId: 'chooser-one', uploadIds: ['upload-one'] });
});

test('upload rejects oversize files and cancellation prevents file selection', async () => {
  await assert.rejects(uploadBrowserFiles([{ size: 101 * 1024 * 1024 } as File], 'chooser', async () => { assert.fail('must reject before sending'); }, () => {}), /100 MiB/);
  const abort = new AbortController();
  const actions: string[] = [];
  await assert.rejects(uploadBrowserFiles([new File(['data'], 'small.txt')], 'chooser', async <T>(action: string) => {
    actions.push(action); abort.abort(); return { uploadId: 'upload' } as T;
  }, () => {}, abort.signal), /cancelled/);
  assert.deepEqual(actions, ['fileUploadBegin']);
});

test('clipboard shortcuts are recognised on every OS layout and never swallow AltGr or plain keys', () => {
  const key = (value: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => clipboardShortcut({ key: value, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(key('v', { ctrlKey: true }), 'paste');
  assert.equal(key('V', { ctrlKey: true, shiftKey: true }), 'paste');
  assert.equal(key('c', { metaKey: true }), 'copy');
  assert.equal(key('X', { ctrlKey: true }), 'cut');
  assert.equal(key('Insert', { shiftKey: true }), 'paste');
  assert.equal(key('Insert', { ctrlKey: true }), 'copy');
  assert.equal(key('Delete', { shiftKey: true }), 'cut');
  assert.equal(key('v', { ctrlKey: true, altKey: true }), null, 'AltGr+V is a character, not a paste');
  assert.equal(key('v'), null);
  assert.equal(key('Delete'), null);
  assert.equal(key('a', { ctrlKey: true }), null);
});
