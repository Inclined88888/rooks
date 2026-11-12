/**
 * Routes of the HTML documents (ADR-MCPUI D3). Every one names who may call
 * it, by `auth.kind`, never by `isSuperadmin` alone: the daemon token is a
 * superadmin with a global view, and it is neither a mission nor a browser.
 *
 *  - create: a mission's own token (origin `agent`), or its owner's session
 *    (origin `user`, display only);
 *  - views (no HTML): a session that reads the mission, or that mission's token;
 *  - the HTML itself: a session only. The iframe's navigation request leaves
 *    the Rooks page, same site, so the `Lax` cookie goes with it; a token in
 *    the URL would put a secret where logs and history keep it;
 *  - the reply: the owner's session only — never a mission's token (an agent
 *    does not answer its own card), never another account's superadmin;
 *  - dismiss: the owner's session, or the token of the mission that created it.
 */
import type { Request, Response, Router } from 'express';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAutonomousMission, missionPermissionModel } from '../../agent.js';
import { loadConfig } from '../../agent-config.js';
import type { PermissionModel } from '../../backends/types.js';
import { MediaError, parseMediaPath, realOrNull, underRoot } from '../../chat-media.js';
import { dbApi, type MissionRow } from '../../db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden, viewerFromRequest, isPersonAuth } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { nestingDepth } from '../settings/island-model.js';
import { defaultProposalWaitMs } from '../terminal-web/proposals.js';
import {
  CreateBody,
  createUiDocument,
  DocumentId,
  documentHeaders,
  injectBootstrap,
  ListQuery,
  MAX_DOCUMENTS_PER_MISSION,
  MAX_HTML_BYTES,
  MAX_REPLY_BYTES,
  MAX_REPLY_DEPTH,
  projectUiDocument,
  ReplyBody,
  type UiDocumentReader,
} from './model.js';
import {
  documentReplyText,
  PENDING_REPLY,
  replyDeliverable,
  resolveUiDocument,
  UNATTENDED_REPLY,
  waitForDocumentReply,
} from './requests.js';
import { apiError } from '../../api-error.js';

export type UiDocumentRouteOptions = {
  /** How long an agent's call waits for the answer; tests shorten it. */
  waitMs?: (model: PermissionModel | null) => number;
  /** Tests stand in for a live mission's backend, and for the agent a late answer goes to. */
  permissionModel?: (missionId: string) => PermissionModel | null;
  deliverLate?: (missionId: string, text: string) => void;
};

type Read = { mission: MissionRow; reader: UiDocumentReader };

/** The mission as its reader sees it, or the refusal already sent. Another account's mission is a 404. */
function readMission(req: Request, res: Response, missionId: string): Read | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (isPersonAuth(auth) && auth.user) {
    const mission = scopedDb(viewerFromRequest(req)).getMission(missionId);
    if (!mission) { res.status(404).json(apiError('not_found', 'not_found')); return null; }
    return { mission, reader: { kind: 'session' } };
  }
  if (auth.kind === 'api-token' && auth.missionId) {
    // The token's own mission, read through its viewer like any other read.
    const mission = auth.missionId === missionId ? scopedDb(viewerFromRequest(req)).getMission(missionId) : undefined;
    if (!mission) { res.status(404).json(apiError('not_found', 'not_found')); return null; }
    return { mission, reader: { kind: 'mission', missionId: mission.id } };
  }
  forbidden(req, res, { kind: 'scope', reason: 'a document is read from a browser session or by its own mission' });
  return null;
}

class HtmlFileError extends Error {
  constructor(readonly status: 400 | 404 | 413 | 415, readonly code: string) {
    super(code);
  }
}

/** Where a mission's files may be read from: its worktree, else its agent's directory. */
function missionRoots(mission: MissionRow): string[] {
  let cwd: string | undefined;
  try { cwd = loadConfig(mission.agent_name).cwd; } catch { cwd = undefined; }
  return [mission.cwd_override ?? cwd].filter((root): root is string => typeof root === 'string' && root.length > 0);
}

/**
 * An HTML file named by absolute path, read only under the mission's roots
 * (the check of `chat_show_media`), bounded and decoded as UTF-8. Every
 * refusal outside the roots answers like a missing file.
 */
export function readMissionHtml(raw: string, roots: readonly string[]): string {
  let path: string;
  try { path = parseMediaPath(raw); } catch (err) {
    if (err instanceof MediaError) throw new HtmlFileError(400, err.code);
    throw err;
  }
  const real = realOrNull(path);
  const realRoots = roots.map(realOrNull).filter((r): r is string => r !== null);
  if (!real || !realRoots.some((root) => underRoot(root, real))) throw new HtmlFileError(404, 'not_found');
  let fd: number;
  try { fd = openSync(real, 'r'); } catch { throw new HtmlFileError(404, 'not_found'); }
  try {
    // Checked on the descriptor read below: whatever the path points to by now.
    const st = fstatSync(fd);
    if (!st.isFile()) throw new HtmlFileError(404, 'not_found');
    if (st.size > MAX_HTML_BYTES) throw new HtmlFileError(413, 'document_too_large');
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buf, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, read));
    } catch {
      throw new HtmlFileError(415, 'not_utf8_text');
    }
  } finally {
    closeSync(fd);
  }
}

export function registerRoutes(app: Router, opts: UiDocumentRouteOptions = {}): void {
  const waitMs = opts.waitMs ?? defaultProposalWaitMs;
  const permissionModel = opts.permissionModel ?? missionPermissionModel;

  app.post('/api/ui-documents', async (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', message: 'expected { title, html | path, reply?, height?, mission_id? }' });
      return;
    }
    const body = parsed.data;
    let mission: MissionRow | undefined;
    let origin: { kind: 'agent' | 'user'; id: string };
    let reader: UiDocumentReader;
    if (auth.kind === 'api-token' && auth.missionId) {
      if (body.mission_id && body.mission_id !== auth.missionId) {
        forbidden(req, res, { kind: 'scope', reason: 'an agent shows a document in its own mission only' });
        return;
      }
      mission = scopedDb(viewerFromRequest(req)).getMission(auth.missionId);
      if (!mission) { res.status(404).json(apiError('not_found', 'not_found')); return; }
      origin = { kind: 'agent', id: mission.agent_name };
      reader = { kind: 'mission', missionId: mission.id };
    } else if (isPersonAuth(auth) && auth.user) {
      if (!body.mission_id) { res.status(400).json({ error: 'invalid_request', message: 'mission_id is required' }); return; }
      mission = scopedDb(viewerFromRequest(req)).getMission(body.mission_id);
      if (!mission) { res.status(404).json(apiError('not_found', 'not_found')); return; }
      if (mission.owner_user_id !== auth.user.id) {
        forbidden(req, res, { kind: 'scope', reason: 'only the owner of a mission shows a document in it' });
        return;
      }
      // The owner showing a page to themself expects no answer from it (D3).
      if (body.reply) {
        res.status(400).json({ error: 'invalid_request', message: 'a document shown by its owner is display only' });
        return;
      }
      origin = { kind: 'user', id: auth.user.id };
      reader = { kind: 'session' };
    } else {
      // The daemon token is not a mission, and no browser carries it.
      forbidden(req, res, { kind: 'scope', reason: 'a document is shown by a mission\'s agent or by its owner\'s session' });
      return;
    }
    if (!mission.owner_user_id) {
      res.status(409).json({ error: 'no_owner', message: 'this mission has no owner account to show the document to' });
      return;
    }
    let html: string;
    if (body.html !== undefined) {
      html = body.html;
    } else {
      try {
        html = readMissionHtml(body.path!, missionRoots(mission));
      } catch (err) {
        if (err instanceof HtmlFileError) { res.status(err.status).json({ error: err.code }); return; }
        throw err;
      }
    }
    const created = createUiDocument({
      id: randomUUID(), mission, origin, title: body.title, html, height: body.height ?? null, expectsReply: body.reply === true,
    });
    if (!created.ok) {
      res.status(created.status).json({
        error: created.error,
        ...(created.error === 'too_many_documents' ? { message: `at most ${MAX_DOCUMENTS_PER_MISSION} documents per mission` } : {}),
        ...(created.error === 'document_too_large' ? { message: `at most ${MAX_HTML_BYTES} bytes of HTML` } : {}),
      });
      return;
    }
    // The content stays out of the audit trail: it may quote a secret.
    auditRequest(req, 'ui.document.create', created.row.id);
    const id = created.row.id;
    if (created.row.status !== 'pending') {
      res.status(201).json({ id, status: created.row.status, document: projectUiDocument(created.row, reader) });
      return;
    }
    if (isAutonomousMission(mission)) {
      // Not waited for, not forgotten either: an answer given while the mission runs reaches it.
      res.status(202).json({ id, status: 'pending', message: UNATTENDED_REPLY });
      return;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    // The agent's call gone (MCP timeout, process death): the answer goes out as a message.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const settled = await waitForDocumentReply(id, waitMs(permissionModel(mission.id)), gone.signal);
    if (res.writableEnded || res.destroyed) return;
    if (!settled || settled.status === 'pending') {
      res.status(202).json({ id, status: 'pending', message: PENDING_REPLY });
      return;
    }
    const view = projectUiDocument(settled, reader);
    res.json({ id, status: settled.status, ...('reply' in view ? { reply: view.reply } : {}), message: documentReplyText(settled) });
  });

  // The owner's answer, from the card: what the document's `submit` sent.
  app.post('/api/ui-documents/:id/reply', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isPersonAuth(auth) || !auth.user) {
      // A mission's token never answers its own card; the daemon token is no browser.
      forbidden(req, res, { kind: 'scope', reason: 'a document is answered from its owner\'s browser session' });
      return;
    }
    const id = DocumentId.safeParse(req.params.id);
    const row = id.success ? dbApi.getUiDocument(id.data.toLowerCase()) : undefined;
    // Another account's document answers like a missing one, superadmin included: its owner alone replies.
    if (!row || row.owner_user_id !== auth.user.id) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    // Nesting first, without recursion: zod walks what it is given.
    if (nestingDepth(req.body) > MAX_REPLY_DEPTH + 1) { res.status(400).json({ error: 'reply_too_deep' }); return; }
    const parsed = ReplyBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'invalid_request', message: 'expected { reply: object }' }); return; }
    const text = JSON.stringify(parsed.data.reply);
    if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) {
      res.status(400).json({ error: 'reply_too_large', message: `at most ${MAX_REPLY_BYTES} bytes of JSON` });
      return;
    }
    const outcome = resolveUiDocument(row.id, { status: 'answered', reply: text }, { kind: 'user', id: auth.user.id }, {
      deliver: opts.deliverLate,
    });
    if (!outcome.ok) {
      res.status(outcome.error === 'not_found' ? 404 : 409).json({ error: outcome.error });
      return;
    }
    // The reply stays out of the audit trail, like the HTML.
    auditRequest(req, 'ui.document.reply', row.id);
    res.json({ document: projectUiDocument(outcome.row, { kind: 'session' }), delivered: outcome.delivered });
  });

  // Closed without an answer by its owner, or taken back by the mission that showed it.
  app.post('/api/ui-documents/:id/dismiss', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = DocumentId.safeParse(req.params.id);
    const row = id.success ? dbApi.getUiDocument(id.data.toLowerCase()) : undefined;
    let by: { kind: 'user' | 'agent'; id: string | null };
    let reader: UiDocumentReader;
    if (isPersonAuth(auth) && auth.user) {
      if (!row || row.owner_user_id !== auth.user.id) { res.status(404).json(apiError('not_found', 'not_found')); return; }
      by = { kind: 'user', id: auth.user.id };
      reader = { kind: 'session' };
    } else if (auth.kind === 'api-token' && auth.missionId) {
      if (!row || row.mission_id !== auth.missionId || row.origin_kind !== 'agent') { res.status(404).json(apiError('not_found', 'not_found')); return; }
      by = { kind: 'agent', id: row.origin_id };
      reader = { kind: 'mission', missionId: auth.missionId };
    } else {
      forbidden(req, res, { kind: 'scope', reason: 'a document is closed by its owner\'s session or by the mission that showed it' });
      return;
    }
    if (req.body && typeof req.body === 'object' && Object.keys(req.body as object).length) {
      res.status(400).json({ error: 'invalid_request', message: 'expected an empty body' });
      return;
    }
    const outcome = resolveUiDocument(row.id, { status: 'dismissed' }, by, { deliver: opts.deliverLate });
    if (!outcome.ok) { res.status(outcome.error === 'not_found' ? 404 : 409).json({ error: outcome.error }); return; }
    auditRequest(req, 'ui.document.dismiss', row.id);
    res.json({ document: projectUiDocument(outcome.row, reader) });
  });

  app.get('/api/ui-documents', (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) {
      if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
      res.status(400).json({ error: 'invalid_request', message: 'expected ?mission_id=' });
      return;
    }
    const read = readMission(req, res, q.data.mission_id);
    if (!read) return;
    const rows = dbApi.listUiDocuments({ missionId: read.mission.id, limit: q.data.limit ?? MAX_DOCUMENTS_PER_MISSION });
    res.json({ documents: rows.map((row) => projectUiDocument(row, read.reader)) });
  });

  app.get('/api/ui-documents/:id', (req, res) => {
    if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = DocumentId.safeParse(req.params.id);
    const row = id.success ? dbApi.getUiDocument(id.data.toLowerCase()) : undefined;
    if (!row) {
      // Same answer as a document of another account, once the caller is known to be a reader at all.
      if (isPersonAuth(req.auth) || (req.auth.kind === 'api-token' && req.auth.missionId)) {
        res.status(404).json(apiError('not_found', 'not_found'));
      } else {
        forbidden(req, res, { kind: 'scope', reason: 'a document is read from a browser session or by its own mission' });
      }
      return;
    }
    const read = readMission(req, res, row.mission_id);
    if (!read) return;
    // Whether an answer given now still reaches the agent: the card says so when it would not (D7).
    const deliverable = row.status === 'pending' && row.origin_kind === 'agent' ? replyDeliverable(row) : undefined;
    res.json({ document: projectUiDocument(row, read.reader), ...(deliverable === undefined ? {} : { deliverable }) });
  });

  // The HTML. A session only: neither the mission's token (an agent has no
  // business rendering it) nor the daemon token (no browser carries it).
  app.get('/api/ui-documents/:id/document', (req, res) => {
    const auth = req.auth;
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!isPersonAuth(auth) || !auth.user) {
      forbidden(req, res, { kind: 'scope', reason: 'a document is opened from a browser session' });
      return;
    }
    const id = DocumentId.safeParse(req.params.id);
    const row = id.success ? dbApi.getUiDocument(id.data.toLowerCase()) : undefined;
    const mission = row ? scopedDb(viewerFromRequest(req)).getMission(row.mission_id) : undefined;
    if (!row || !mission) { res.status(404).json(apiError('not_found', 'not_found')); return; }
    const body = row.bridge === 'rooks' ? injectBootstrap(row.html) : row.html;
    res.status(200).set(documentHeaders()).send(body);
  });
}
