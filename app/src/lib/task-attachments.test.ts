/**
 * The app's side of the attached files of a task or a TO DO idea
 * (`task-attachments.ts`): what is refused before the bytes travel, what an
 * upload sends, where each owner's files live, and how a refusal of the
 * daemon comes back and is shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentRefusalText, deleteTaskAttachment, deleteTodoAttachment, isImageName, listTodoAttachments,
  MAX_TASK_ATTACHMENT_BYTES, precheckTaskAttachment, taskAttachmentUrl, todoAttachmentUrl, uploadTaskAttachment,
  uploadTodoAttachment,
} from './task-attachments';
import { getLocale, setLocale } from './i18n';
import { formatBytes } from './intl';

const EMPTY = { count: 0, bytes: 0 };

test('a type the daemon refuses, a file too large or a full task is refused before any upload', () => {
  assert.equal(precheckTaskAttachment({ name: 'page.svg', size: 10 }, EMPTY)?.code, 'attachment_type_refused');
  assert.equal(precheckTaskAttachment({ name: 'setup.exe', size: 10 }, EMPTY)?.code, 'attachment_type_refused');
  assert.equal(precheckTaskAttachment({ name: 'install.sh', size: 10 }, EMPTY)?.code, 'attachment_type_refused');
  assert.equal(precheckTaskAttachment({ name: 'repro.py', size: 10 }, EMPTY), null);
  assert.equal(precheckTaskAttachment({ name: 'noextension', size: 10 }, EMPTY)?.code, 'attachment_type_refused');
  assert.equal(precheckTaskAttachment({ name: 'big.png', size: MAX_TASK_ATTACHMENT_BYTES + 1 }, EMPTY)?.code, 'attachment_too_large');
  assert.equal(precheckTaskAttachment({ name: 'one.png', size: 10 }, { count: 20, bytes: 10 })?.code, 'attachment_quota');
  assert.equal(precheckTaskAttachment({ name: 'one.png', size: 2_000_000 }, { count: 3, bytes: 99 * 1024 * 1024 })?.code, 'attachment_quota');
  assert.equal(precheckTaskAttachment({ name: 'Mockup.PNG', size: 10 }, EMPTY), null, 'the extension is read case-blind');
  assert.equal(precheckTaskAttachment({ name: 'notes.md', size: 10 }, EMPTY), null);
});

test('images are told from documents by their extension, and served under the owning task', () => {
  assert.equal(isImageName('a.webp'), true);
  assert.equal(isImageName('a.pdf'), false);
  const att = { id: '0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e', task_id: 'root-task' };
  assert.equal(taskAttachmentUrl(att), '/api/ui/tasks/root-task/attachments/0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e');
  assert.equal(taskAttachmentUrl(att, true), '/api/ui/tasks/root-task/attachments/0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e?download=1');
});

test('sizes read in the locale\'s own units', () => {
  assert.equal(formatBytes(12, 'en'), '12 byte');
  assert.equal(formatBytes(1_500_000, 'en'), '1.5 MB');
  assert.equal(formatBytes(1_500_000, 'fr').replace(/\s/g, ' '), '1,5 Mo');
});

async function withFetch(stub: (url: string, init?: RequestInit) => Response, run: (calls: { url: string; init?: RequestInit }[]) => Promise<void>) {
  const previous = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return stub(String(input), init);
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = previous; }
}

test('an upload sends the name, the base64 bytes without prefix and the browser type', async () => {
  const attachment = { id: 'a1', task_id: 't1', name: 'a.png', size: 3, mime: 'image/png', kind: 'image', created_at: 1 };
  await withFetch(() => Response.json({ attachment }, { status: 201 }), async (calls) => {
    const r = await uploadTaskAttachment('t1', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
    assert.deepEqual(r, { ok: true, attachment });
    assert.equal(calls[0]?.url, '/api/ui/tasks/t1/attachments');
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { name: 'a.png', data: 'AQID', mime: 'image/png' });
  });
});

test('a refusal of the daemon comes back with its code and its text', async () => {
  await withFetch(() => Response.json({ error: 'File content does not match .png.', code: 'attachment_content_mismatch' }, { status: 415 }), async () => {
    const r = await uploadTaskAttachment('t1', new File(['MZ'], 'a.png'));
    assert.deepEqual(r, { ok: false, refusal: { code: 'attachment_content_mismatch', message: 'File content does not match .png.' } });
  });
  await withFetch(() => new Response('nope', { status: 403 }), async (calls) => {
    const r = await deleteTaskAttachment({ id: 'a1', task_id: 't1' });
    assert.deepEqual(r, { ok: false, refusal: { code: 'attachment_failed', message: 'HTTP 403' } });
    assert.equal(calls[0]?.init?.method, 'DELETE');
  });
});

test('an idea\'s files are listed, sent, served and removed under the idea\'s own routes', async () => {
  const att = { id: '0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e', todo_id: 209 };
  assert.equal(todoAttachmentUrl(att), '/api/ui/project-todo/209/attachments/0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e');
  assert.equal(todoAttachmentUrl(att, true), '/api/ui/project-todo/209/attachments/0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e?download=1');
  const attachment = { ...att, name: 'a.md', size: 2, mime: 'text/markdown', kind: 'document', created_at: 1 };
  await withFetch((url, init) => (init?.method === 'POST'
    ? Response.json({ attachment }, { status: 201 })
    : init?.method === 'DELETE' ? Response.json({ ok: true }) : Response.json({ attachments: [attachment] })), async (calls) => {
    assert.deepEqual(await listTodoAttachments(209), [attachment]);
    assert.deepEqual(await uploadTodoAttachment(209, new File(['ok'], 'a.md', { type: 'text/markdown' })), { ok: true, attachment });
    assert.deepEqual(await deleteTodoAttachment(att), { ok: true });
    assert.deepEqual(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`), [
      'GET /api/ui/project-todo/209/attachments',
      'POST /api/ui/project-todo/209/attachments',
      `DELETE /api/ui/project-todo/209/attachments/${att.id}`,
    ]);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { name: 'a.md', data: 'b2s=', mime: 'text/markdown' });
  });
});

test('a 413 or a 415 without the daemon\'s code still reads as too large or refused', async () => {
  await withFetch(() => new Response('<html>413 Request Entity Too Large</html>', { status: 413 }), async () => {
    const r = await uploadTodoAttachment(209, new File(['x'], 'a.pdf'));
    assert.equal(r.ok ? null : r.refusal.code, 'attachment_too_large');
  });
  await withFetch(() => new Response('', { status: 415 }), async () => {
    const r = await uploadTodoAttachment(209, new File(['x'], 'a.pdf'));
    assert.equal(r.ok ? null : r.refusal.code, 'attachment_type_refused');
  });
});

test('a refusal is shown with the interface\'s sentence, never the daemon\'s text', () => {
  const previous = getLocale();
  setLocale('en');
  try {
    const say = (code: string, owner: 'task' | 'todo' = 'todo') =>
      attachmentRefusalText('a.pdf', { code, message: 'secret /home/x/.timon detail' }, owner);
    assert.equal(say('attachment_too_large'), 'a.pdf: too large (15 MB at most).');
    assert.equal(say('attachment_type_refused'), 'a.pdf: this type of file is not accepted.');
    assert.equal(say('attachment_content_mismatch'), 'a.pdf: this type of file is not accepted.');
    assert.match(say('attachment_quota'), /the idea already holds/);
    assert.match(say('attachment_quota', 'task'), /the task already holds/);
    for (const code of ['attachment_invalid', 'attachment_write_failed', 'attachment_failed', 'unknown']) {
      assert.equal(say(code), 'a.pdf: could not be sent.', code);
    }
  } finally {
    setLocale(previous);
  }
});
