/**
 * `rooks backend add|list|test|rm`: the terminal's door to `/api/backends/custom`,
 * and the backend-profile section of `rooks doctor`.
 *
 * The routes decide everything: same bodies as the Settings form, no validator
 * of its own, and who may act is `plugins-bundled/backends/change-gate.ts` (a
 * person, never an agent). What this file owns is the one thing a route cannot
 * see: where the key comes from. It never comes from an argument or from the
 * caller's environment, since a command line is readable through
 * /proc/<pid>/cmdline and stays in the shell history.
 */

import { PROMPT_CANCELLED } from './cli-prompt.mjs';

const USAGE = 'usage: rooks backend add <name> --base-url URL --protocol anthropic|openai-responses\n'
  + '         [--key-from-stdin | --no-key] [--id ID] [--models A,B] [--default-model SLUG] [--brand KEY] [--icon VALUE] [--json]\n'
  + '       rooks backend list [--json]\n'
  + '       rooks backend test <id> [--json]\n'
  + '       rooks backend test --base-url URL --protocol anthropic|openai-responses [--key-from-stdin | --no-key] [--json]\n'
  + '       rooks backend rm <id> [--json]\n';

const KEY_IN_ARGV = 'rooks backend: the key is never passed as an argument.\n'
  + 'A command line is readable by other local processes and stays in your shell history.\n'
  + 'If you just typed a real key, treat it as exposed and change it. Then either run the\n'
  + 'command in a terminal to be asked for it (input hidden), or pipe it:\n'
  + '  printf %s "$KEY" | rooks backend add NAME --base-url URL --protocol PROTOCOL --key-from-stdin\n';

// `-k` and the plain names are what someone reaches for out of habit from other CLIs.
const KEY_FLAG = /^(-k|--(key|api-?key|token|secret|password))(=|$)/i;

const ADD_VALUES = ['base-url', 'protocol', 'id', 'models', 'default-model', 'brand', 'icon'];
const TEST_VALUES = ['base-url', 'protocol'];
const KEY_SWITCHES = ['key-from-stdin', 'no-key'];

/** The form's field names, as the flags that fill them here. */
const FIELD_FLAGS = {
  name: '<name>', baseUrl: '--base-url', protocol: '--protocol', key: 'the key', id: '--id',
  models: '--models', defaultModel: '--default-model', icon: '--icon', brand: '--brand',
};

class Stop extends Error {
  constructor(code, message = '') {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv, valueFlags, switches) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (KEY_FLAG.test(arg)) throw new Stop(64, KEY_IN_ARGV);
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    const equals = arg.indexOf('=');
    const name = (equals > 0 ? arg.slice(0, equals) : arg).replace(/^--/, '');
    if (arg.startsWith('--') && valueFlags.includes(name)) {
      const value = equals > 0 ? arg.slice(equals + 1) : argv[++i];
      if (value === undefined || (equals < 0 && value.startsWith('--'))) throw new Stop(64, `rooks backend: --${name} needs a value\n${USAGE}`);
      flags[name] = value;
      continue;
    }
    if (arg.startsWith('--') && equals < 0 && switches.includes(name)) { flags[name] = true; continue; }
    throw new Stop(64, unexpectedArgument());
  }
  return { flags, positionals };
}

/** Never quotes what it refuses: a stray argument is exactly where a key lands. */
function unexpectedArgument() {
  return `rooks backend: unexpected argument (not shown, it could be a key). Quote a name that has spaces.\n${USAGE}`;
}

/** Refused here rather than at the route: by the time the daemon sees it, the
 *  credential has already been on this command line. A query string serves no
 *  purpose in a base URL either: paths are appended to it. */
function refuseCredentialsInUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return; // Not a URL: the route says so, and it is the only validator.
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Stop(64, 'rooks backend: --base-url cannot carry a user, a password, a query string or a fragment (not shown, it could hold a key).\n'
      + 'Give the plain address, and the key with --key-from-stdin or at the prompt.\n');
  }
}

async function resolveKey(flags, io, deps) {
  if (flags['key-from-stdin'] && flags['no-key']) throw new Stop(64, 'rooks backend: choose between --key-from-stdin and --no-key\n');
  if (flags['no-key']) return undefined;
  const noKeyHint = 'An endpoint that asks for none takes --no-key.\n';
  let key;
  if (flags['key-from-stdin']) {
    // Reading a terminal here would show the key as it is typed.
    if (deps.stdin.isTTY) throw new Stop(64, 'rooks backend: --key-from-stdin needs the key piped on stdin; without the flag, a terminal asks for it with the input hidden.\n');
    key = await deps.readAll(deps.stdin);
  } else if (deps.stdin.isTTY) {
    try {
      key = await deps.readHiddenLine('API key (input hidden): ');
    } catch (error) {
      // 128 + SIGINT, what a shell reports for Ctrl-C. The person asked for it: nothing to explain.
      if (error?.code === PROMPT_CANCELLED) throw new Stop(130);
      throw error;
    }
  } else {
    throw new Stop(64, 'rooks backend: no key given, and no terminal to ask for it. Pipe it and pass --key-from-stdin.\n'
      + noKeyHint + 'The key is never an argument.\n');
  }
  key = key.trim();
  // An empty pipe is a failed `$(…)` far more often than a choice: not a keyless backend.
  if (!key) throw new Stop(64, `rooks backend: the key is empty. ${noKeyHint}`);
  io.key = key;
  return key;
}

function refusalMessage(verb, status, body) {
  const data = body && typeof body === 'object' ? body : {};
  const code = typeof data.code === 'string' ? data.code : null;
  const where = `rooks backend ${verb}: refused (${status}${code ? ` ${code}` : ''})`;
  if (code === 'operator_only') {
    const reason = typeof data.reason === 'string' ? data.reason : 'backends are changed by a person, never by an agent';
    return `${where} — ${reason}\n${typeof data.hint === 'string' ? `${data.hint}\n` : ''}`;
  }
  if (Array.isArray(data.fields)) {
    const named = data.fields.map((field) => FIELD_FLAGS[field] ?? String(field)).join(', ');
    return `${where} — check ${named}\n`;
  }
  const reason = [data.reason, data.message, data.error].find((value) => typeof value === 'string');
  const hint = typeof data.hint === 'string' ? ` Hint: ${data.hint}` : '';
  // A body that is not ours (a proxy's page) is not relayed at all.
  return `${where}${reason ? ` — ${reason}` : ''}${hint}\n`;
}

async function call(deps, verb, method, path, body) {
  let response;
  try {
    response = await deps.httpRaw(method, path, body);
  } catch {
    throw new Stop(1, `rooks backend ${verb}: the Rooks daemon does not answer (rooks service status).\n`);
  }
  if (!response.ok) throw new Stop(2, refusalMessage(verb, response.status, response.body));
  return response.body;
}

function plainAddress(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return '(invalid address)';
  }
}

/**
 * A base URL written by hand in a file may carry `user:key@`, and the listing
 * relays what the file says. The form cannot produce one, so nothing is lost.
 */
function publicBackend(backend) {
  return 'baseUrl' in backend ? { ...backend, baseUrl: plainAddress(backend.baseUrl) } : backend;
}

function stateOf(backend) {
  if (backend.disabled) return 'disabled';
  return backend.active ? 'active' : 'inactive';
}

async function cmdAdd(argv, io, deps) {
  const { flags, positionals } = parseArgs(argv, ADD_VALUES, [...KEY_SWITCHES, 'json']);
  if (positionals.length > 1) throw new Stop(64, unexpectedArgument());
  const [name] = positionals;
  if (!name || !flags['base-url'] || !flags.protocol) throw new Stop(64, USAGE);
  refuseCredentialsInUrl(flags['base-url']);
  const key = await resolveKey(flags, io, deps);
  const models = (flags.models ?? '').split(',').map((model) => model.trim()).filter(Boolean);
  const form = {
    ...(flags.id ? { id: flags.id } : {}),
    name: name.trim(),
    baseUrl: flags['base-url'].trim(),
    protocol: flags.protocol,
    ...(key ? { key } : {}),
    ...(models.length ? { models } : {}),
    ...(flags['default-model'] ? { defaultModel: flags['default-model'] } : {}),
    ...(flags.icon ? { icon: flags.icon } : {}),
    ...(flags.brand ? { brand: flags.brand } : {}),
  };
  const { backend } = await call(deps, 'add', 'POST', '/api/backends/custom', form);
  if (flags.json) { io.out(`${JSON.stringify(publicBackend(backend), null, 2)}\n`); return; }
  io.out(`added ${backend.id} (${backend.label}, ${backend.protocol ?? 'unknown protocol'}) — ${backend.hasVaultKey ? 'key stored in the vault, reserved to this backend' : 'no key'}\n`);
  if (backend.reason) io.out(`  inactive: ${backend.reason}\n`);
  io.out(`  check it: rooks backend test ${backend.id}\n`);
}

async function cmdList(argv, io, deps) {
  const { flags, positionals } = parseArgs(argv, [], ['json']);
  if (positionals.length) throw new Stop(64, unexpectedArgument());
  const listing = await call(deps, 'list', 'GET', '/api/backends/custom');
  const backends = (Array.isArray(listing?.backends) ? listing.backends : []).map(publicBackend);
  if (flags.json) { io.out(`${JSON.stringify({ ...listing, backends }, null, 2)}\n`); return; }
  if (!backends.length) { io.out('No backend added yet: rooks backend add, or Settings → AI models → LLM backends.\n'); return; }
  for (const backend of backends) {
    const models = (backend.models ?? []).length;
    io.out(`${backend.id.padEnd(24)} ${stateOf(backend).padEnd(9)} ${String(backend.protocol ?? '-').padEnd(17)} ${backend.hasVaultKey ? 'vault key' : 'no key   '}  ${models} model(s)  ${backend.baseUrl ?? '-'}\n`);
    if (backend.reason) io.out(`  ${backend.reason}\n`);
    for (const warning of backend.warnings ?? []) io.out(`  warning: ${warning}\n`);
  }
}

function outcomeText(result) {
  switch (result?.outcome) {
    case 'ok': {
      const models = result.models ?? [];
      return `ok — the endpoint answers and accepts the key (HTTP ${result.status})${models.length ? `\nmodels: ${models.join(', ')}` : ''}`;
    }
    case 'key-refused': return `key refused — the endpoint answers but refuses the key (HTTP ${result.status})`;
    case 'unreachable': return 'unreachable — nothing answers at this address';
    case 'unexpected-status': return `unexpected status — the endpoint answers (HTTP ${result.status}), the key could not be checked`;
    default: return 'unknown result';
  }
}

async function cmdTest(argv, io, deps) {
  const { flags, positionals } = parseArgs(argv, TEST_VALUES, [...KEY_SWITCHES, 'json']);
  if (positionals.length > 1) throw new Stop(64, unexpectedArgument());
  const [id] = positionals;
  const adHoc = flags['base-url'] !== undefined || flags.protocol !== undefined;
  // The route refuses the mix too: a saved key only ever goes to its saved
  // address. Saying so here spares a prompt for a key that would not be used.
  if (id && (adHoc || KEY_SWITCHES.some((name) => flags[name]))) {
    throw new Stop(64, 'rooks backend test: a saved backend is tested with its own key and address; pass an <id> alone, or --base-url and --protocol without one.\n');
  }
  let body;
  if (id) {
    body = { id };
  } else {
    if (!flags['base-url'] || !flags.protocol) throw new Stop(64, USAGE);
    refuseCredentialsInUrl(flags['base-url']);
    const key = await resolveKey(flags, io, deps);
    body = { protocol: flags.protocol, baseUrl: flags['base-url'].trim(), ...(key ? { key } : {}) };
  }
  const result = await call(deps, 'test', 'POST', '/api/backends/custom/test', body);
  io.out(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${outcomeText(result)}\n`);
  if (result?.outcome !== 'ok') throw new Stop(1);
}

async function cmdRm(argv, io, deps) {
  const { flags, positionals } = parseArgs(argv, [], ['json']);
  if (positionals.length !== 1) throw new Stop(64, positionals.length > 1 ? unexpectedArgument() : USAGE);
  const [id] = positionals;
  const result = await call(deps, 'rm', 'DELETE', `/api/backends/custom/${encodeURIComponent(id)}`);
  if (flags.json) { io.out(`${JSON.stringify(result, null, 2)}\n`); return; }
  // Only the route knows what left the vault. A daemon too old to say claims nothing.
  const left = Array.isArray(result?.removedSecrets) ? result.removedSecrets : [];
  io.out(left.length ? `removed ${id}; ${left.join(', ')} left the vault too\n` : `removed ${id}\n`);
}

/**
 * @param {string[]} argv what follows `rooks backend`
 * @param {{ httpRaw: Function, readAll: Function, readHiddenLine: Function, stdin: { isTTY?: boolean },
 *   out: (text: string) => void, err: (text: string) => void, exit: (code: number) => void }} deps
 */
export async function cmdBackend(argv, deps) {
  // Whatever a daemon, a proxy or a newer route may echo, the value read from
  // the operator does not reach the screen or a pipe from here.
  const io = {
    key: undefined,
    scrub(text) {
      if (!this.key) return text;
      return text.split(this.key).join('[key hidden]').split(JSON.stringify(this.key).slice(1, -1)).join('[key hidden]');
    },
    out(text) { deps.out(this.scrub(text)); },
  };
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case 'add': await cmdAdd(rest, io, deps); break;
      case 'list': await cmdList(rest, io, deps); break;
      case 'test': await cmdTest(rest, io, deps); break;
      case 'rm': await cmdRm(rest, io, deps); break;
      default: throw new Stop(64, USAGE);
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.message) deps.err(io.scrub(error.message));
    deps.exit(error.code);
  }
}

/* ─── `rooks doctor` section ─── */

function rowFromRoute(backend) {
  const error = !backend.disabled && !backend.active;
  return {
    id: backend.id,
    label: backend.label,
    state: backend.disabled ? 'disabled' : error ? 'error' : 'active',
    testable: !!(backend.protocol && backend.baseUrl),
    hasVaultKey: backend.hasVaultKey === true,
    reason: backend.reason ?? null,
    warnings: backend.warnings ?? [],
  };
}

/** A process that loaded no provider cannot say whether a dialect is installed,
 *  so the files only tell what they are: readable, or why not. */
function rowFromFile(entry, secretNamesOf) {
  return {
    id: entry.id,
    label: entry.profile?.label ?? entry.id,
    state: entry.issue ? 'error' : entry.profile?.disabled ? 'disabled' : 'unknown',
    testable: null,
    hasVaultKey: entry.profile ? secretNamesOf(entry.profile).length > 0 : false,
    reason: entry.issue ?? null,
    warnings: entry.warnings ?? [],
  };
}

function summarize(source, note, profiles) {
  return {
    source,
    note,
    present: profiles.length,
    testable: source === 'daemon' ? profiles.filter((row) => row.testable).length : null,
    inError: profiles.filter((row) => row.state === 'error').length,
    profiles,
  };
}

async function readProfileFiles(loadLocalProfiles, why) {
  try {
    const { reloadLocalBackends, secretNamesOf } = await loadLocalProfiles();
    return summarize('files', why, reloadLocalBackends().map((entry) => rowFromFile(entry, secretNamesOf)));
  } catch {
    // Doctor still has to answer on a machine whose data cannot be opened yet (update pending).
    return summarize('unavailable', `${why} The backend files could not be read either.`, []);
  }
}

/**
 * The profiles of this machine, for `rooks doctor`. The daemon's own listing
 * when it is this machine's daemon, since only it knows which ones run; the
 * files otherwise. Fields are picked one by one: the address stays out, as
 * doctor's text gets pasted in support requests. It looks and changes nothing,
 * so it reports what `rooks backend test` could check without running it (a
 * test calls the network and records what the endpoint says).
 *
 * @param {{ local: boolean, fetchListing: () => Promise<{ ok: boolean, status: number, body: unknown }>,
 *   loadLocalProfiles: () => Promise<{ reloadLocalBackends: Function, secretNamesOf: Function }> }} deps
 */
export async function backendProfilesReport({ local, fetchListing, loadLocalProfiles }) {
  if (!local) return readProfileFiles(loadLocalProfiles, 'The CLI targets another daemon: only this machine\'s files were read, their state is unknown.');
  let why;
  try {
    const response = await fetchListing();
    const backends = response.ok ? response.body?.backends : undefined;
    if (Array.isArray(backends)) return summarize('daemon', null, backends.map(rowFromRoute));
    why = `The daemon refused the listing (${response.status}): only the files were read, their state is unknown.`;
  } catch {
    why = 'The daemon does not answer: only the files were read, their state is unknown.';
  }
  return readProfileFiles(loadLocalProfiles, why);
}

const STATE_LABEL = { active: 'active', disabled: 'disabled', error: 'ERROR', unknown: 'file ok' };

export function formatBackendProfiles(report) {
  const counts = report.source === 'daemon'
    ? `${report.present} present, ${report.testable} testable, ${report.inError} in error`
    : `${report.present} present, ${report.inError} in error`;
  const lines = [`Backend profiles: ${report.present ? counts : 'none added (rooks backend add)'}`];
  if (report.note) lines.push(`  ${report.note}`);
  for (const row of report.profiles) {
    const testable = row.testable === null ? 'not checked' : row.testable ? 'testable' : 'not testable';
    lines.push(`  ${row.id.padEnd(24)} ${STATE_LABEL[row.state].padEnd(8)} ${testable.padEnd(12)} ${row.hasVaultKey ? 'vault key' : 'no key'}`);
    if (row.reason) lines.push(`    ${row.reason}`);
    for (const warning of row.warnings) lines.push(`    warning: ${warning}`);
  }
  if (report.testable) lines.push('  Check one: rooks backend test <id>');
  return `${lines.join('\n')}\n`;
}
