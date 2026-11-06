/**
 * `timon agent export <names…|--all> [--out F]`, `timon agent import <F>`
 * and `timon agent export-skill [--out F]`
 * (SUG-0084): some agents carried from one Timon to another, on the routes of
 * the `agent-import` plugin. `timon agent import --hermes [profile…]` reads
 * Hermes from the disk of the machine the daemon runs on, no zip made first. Not `timon export` / `timon import`, which move a
 * whole instance.
 *
 * The routes decide who may act (an account that reads agents exports, one
 * that manages them imports); nothing here widens that. The staging token is
 * kept in memory, sent in JSON bodies only, and never printed.
 */
import { basename, resolve } from 'node:path';

const ROUTES = '/api/plugins/agent-import';

export const EXPORT_USAGE = 'usage: timon agent export <name…> | --all [--out FILE] [--force]\n';
export const IMPORT_USAGE = 'usage: timon agent import <FILE> | --hermes [PROFILE…] [--yes] [--accept-cwd] [--prefix PREFIX] [--json]\n';
export const EXPORT_SKILL_USAGE = 'usage: timon agent export-skill [--out FILE] [--force]\n';

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** The archive name the daemon proposes, reduced to a plain file name. */
function proposedName(disposition) {
  const match = /filename="([^"]+)"/.exec(disposition ?? '');
  const name = match ? basename(match[1].replace(/\\/g, '/')) : '';
  return /^[\w.-]+\.zip$/.test(name) ? name : `timon-agents-${stamp(new Date())}.zip`;
}

function errorLine(status, bytes) {
  let body;
  try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { body = null; }
  if (status === 404 && !(body && body.code)) {
    return 'the agent-import plugin does not answer: is it enabled? (timon plugin list)';
  }
  const message = body && typeof body.error === 'string' ? body.error : `HTTP ${status}`;
  return body && typeof body.code === 'string' ? `${message} [${body.code}]` : message;
}

/** One call to a route of the plugin: JSON in, bytes out. */
async function call(io, method, route, { json, bytes, type } = {}) {
  const init = { method, headers: { ...io.headers() } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (bytes !== undefined) {
    init.headers['content-type'] = type;
    init.body = bytes;
  }
  const res = await fetch(`${io.api()}${ROUTES}/${route}`, init);
  const out = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, status: res.status, headers: res.headers, bytes: out };
}

const parse = (bytes) => JSON.parse(bytes.toString('utf8'));

export async function cmdAgentExport(argv, io) {
  const args = [...argv];
  const all = args.includes('--all');
  const force = args.includes('--force');
  const out = io.takeFlag(args, 'out');
  const names = args.filter((a) => a !== '--all' && a !== '--force');
  if (names.some((n) => n.startsWith('--')) || (all ? names.length > 0 : names.length === 0) || out === '') {
    io.err(EXPORT_USAGE);
    return io.exit(64);
  }
  const res = await call(io, 'POST', 'export', { json: all ? { all: true } : { agents: names } });
  if (!res.ok) {
    io.err(`timon: export refused — ${errorLine(res.status, res.bytes)}\n`);
    return io.exit(2);
  }
  const target = resolve(io.cwd(), out ?? proposedName(res.headers.get('content-disposition')));
  try {
    io.writeFile(target, res.bytes, { flag: force ? 'w' : 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      io.err(`timon: ${target} already exists (--force to replace it)\n`);
      return io.exit(1);
    }
    throw err;
  }
  const count = Number(res.headers.get('x-timon-agents') ?? 0);
  io.out(`exported ${count} agent${count === 1 ? '' : 's'} to ${target}\n`);
  io.out('secrets are not in the archive: enter them again on the other Timon.\n');
}

/**
 * The `timon-export` skill, the one another agent tool (Hermes, Grok Bot…)
 * runs to write an archive `timon agent import` reads: printed, or written to
 * `--out` (a file that exists needs `--force`).
 */
export async function cmdAgentExportSkill(argv, io) {
  const args = [...argv];
  const force = args.includes('--force');
  const out = io.takeFlag(args, 'out');
  const rest = args.filter((a) => a !== '--force');
  if (rest.length > 0 || out === '' || (force && out === undefined)) {
    io.err(EXPORT_SKILL_USAGE);
    return io.exit(64);
  }
  const res = await call(io, 'GET', 'export-skill');
  if (!res.ok) {
    io.err(`timon: export skill refused — ${errorLine(res.status, res.bytes)}\n`);
    return io.exit(2);
  }
  if (out === undefined) {
    io.out(res.bytes.toString('utf8'));
    return;
  }
  const target = resolve(io.cwd(), out);
  try {
    io.writeFile(target, res.bytes, { flag: force ? 'w' : 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      io.err(`timon: ${target} already exists (--force to replace it)\n`);
      return io.exit(1);
    }
    throw err;
  }
  io.out(`wrote the timon-export skill to ${target}\n`);
  io.out('give it to the other agent as a skill, then ask it: Export my agents for Timon\n');
}

/** The preview, for a person reading a terminal. */
export function formatPreview(preview) {
  const lines = [];
  const source = preview.source ? `${preview.source.app}${preview.source.exportedAt ? `, exported ${preview.source.exportedAt}` : ''}` : 'unknown source';
  lines.push(`Import from ${source}:`);
  for (const agent of preview.agents ?? []) {
    const target = agent.finalName && agent.action !== 'skip' ? ` → ${agent.finalName}` : '';
    const role = agent.role ? ` (${agent.role})` : '';
    lines.push(`  ${agent.action.padEnd(6)} ${agent.displayName}${target}${role}`);
    if (agent.cwd) lines.push(`         working directory: ${agent.cwd}`);
    if (agent.cwdSuggestion) lines.push(`         suggested working directory: ${agent.cwdSuggestion} (--accept-cwd to use it)`);
    if (agent.backend) lines.push(`         backend: ${agent.backend}${agent.model ? ` / ${agent.model}` : ''}`);
    for (const warning of agent.warnings ?? []) lines.push(`         ! ${warning}`);
  }
  for (const warning of preview.warnings ?? []) lines.push(`  ! ${warning}`);
  return `${lines.join('\n')}\n`;
}

export async function cmdAgentImport(argv, io) {
  const args = [...argv];
  const yes = args.includes('--yes') || args.includes('-y');
  const json = args.includes('--json');
  const acceptCwd = args.includes('--accept-cwd');
  const hermes = args.includes('--hermes');
  const prefix = io.takeFlag(args, 'prefix');
  const rest = args.filter((a) => !['--yes', '-y', '--json', '--accept-cwd', '--hermes'].includes(a));
  const malformed = rest.some((a) => a.startsWith('--')) || prefix === '';
  if (malformed || (!hermes && rest.length !== 1)) {
    io.err(IMPORT_USAGE);
    return io.exit(64);
  }

  let staged;
  if (hermes) {
    // No profile named: every profile the daemon found.
    staged = await call(io, 'POST', 'hermes/stage', { json: rest.length > 0 ? { profiles: rest } : {} });
    if (!staged.ok) {
      io.err(`timon: Hermes cannot be imported — ${errorLine(staged.status, staged.bytes)}\n`);
      return io.exit(2);
    }
  } else {
    let bytes;
    try {
      bytes = io.readFile(resolve(io.cwd(), rest[0]));
    } catch (err) {
      io.err(`timon: cannot read ${rest[0]}: ${err && err.code ? err.code : 'error'}\n`);
      return io.exit(1);
    }
    staged = await call(io, 'POST', 'stage', { bytes, type: 'application/zip' });
    if (!staged.ok) {
      io.err(`timon: the archive was refused — ${errorLine(staged.status, staged.bytes)}\n`);
      return io.exit(2);
    }
  }
  const { token } = parse(staged.bytes);
  const discard = () => call(io, 'POST', 'discard', { json: { token } }).catch(() => undefined);

  const options = prefix ? { prefix } : {};
  let previewed = await call(io, 'POST', 'preview', { json: { token, options } });
  if (previewed.ok && acceptCwd) {
    // A second look with the proposed directories chosen, so what is shown is what is applied.
    const agents = parse(previewed.bytes).preview.agents
      .filter((a) => a.cwdSuggestion)
      .map((a) => ({ sourceRef: a.sourceRef, cwd: a.cwdSuggestion }));
    if (agents.length > 0) {
      options.agents = agents;
      previewed = await call(io, 'POST', 'preview', { json: { token, options } });
    }
  }
  if (!previewed.ok) {
    await discard();
    io.err(`timon: the archive cannot be imported — ${errorLine(previewed.status, previewed.bytes)}\n`);
    return io.exit(2);
  }
  const { preview } = parse(previewed.bytes);
  if (json) io.out(`${JSON.stringify(preview, null, 2)}\n`);
  else io.out(formatPreview(preview));

  const writing = (preview.agents ?? []).filter((a) => a.action !== 'skip').length;
  if (writing === 0) {
    await discard();
    io.out('nothing to import.\n');
    return;
  }
  if (!yes) {
    if (!io.isTTY()) {
      await discard();
      io.err('timon: nothing imported — pass --yes to import without a question\n');
      return io.exit(64);
    }
    const answer = await io.ask(`Import ${writing} agent${writing === 1 ? '' : 's'}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      await discard();
      io.out('nothing imported.\n');
      return;
    }
  }

  const applied = await call(io, 'POST', 'apply', { json: { token, options } });
  if (!applied.ok) {
    io.err(`timon: the import failed — ${errorLine(applied.status, applied.bytes)}\n`);
    return io.exit(2);
  }
  const result = parse(applied.bytes);
  if (json) io.out(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const agent of result.agents ?? []) {
      io.out(`  ${agent.status.padEnd(7)} ${agent.displayName}${agent.agent ? ` → ${agent.agent}` : ''}${agent.error ? `: ${agent.error}` : ''}\n`);
    }
  }
  if ((result.agents ?? []).some((a) => a.status === 'failed')) return io.exit(1);
}
