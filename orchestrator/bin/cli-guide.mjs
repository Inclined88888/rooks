/**
 * What `rooks` says to someone who has just installed it: the overview printed
 * by `rooks` alone, and the message of a command whose daemon does not answer.
 *
 * Pure functions over a state the CLI gathers: the tests feed them states
 * without a daemon, a service or a network.
 */

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** A `fetch` that never reached a daemon, as opposed to a daemon that answered an error. */
export function isDaemonUnreachable(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const code = error.cause?.code ?? error.code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  return error.name === 'TypeError' && error.message === 'fetch failed';
}

/**
 * `local`: the address is this machine's own daemon. `serviceInstalled`:
 * `rooks service install` (or the onboarding) left its marker in this home.
 */
export function unreachableLines({ api, local, serviceInstalled }) {
  const lines = [`rooks: no Rooks daemon answers at ${api}.`];
  if (!local) {
    lines.push('  Check the address, and that the machine is on and runs Rooks.');
    return lines;
  }
  if (serviceInstalled) {
    lines.push('  Rooks is installed as a background service. See why it does not answer:');
    lines.push('    rooks service status');
    lines.push('    rooks doctor');
  } else {
    lines.push('  Run Rooks in the background (starts at boot, keeps running after you log out):');
    lines.push('    rooks service install');
    lines.push('  Or open the Rooks app on this machine.');
  }
  return lines;
}

/**
 * The state of `rooks` alone.
 * - `version`: this CLI's Rooks version, or null.
 * - `reachable`: the daemon answered `/api/health` as Rooks.
 * - `needsSetup`: true before the first account, false after, null unknown.
 * - `appUrl`: the web interface of this machine, or null.
 * - `appLocalOnly`: that address only answers on this machine.
 * - `ssh`: { user, host } when the CLI runs in an SSH session, else null.
 */
export function overviewLines(state) {
  const {
    version = null, api, local = true, reachable, serviceInstalled = false, needsSetup = null,
    appUrl = null, appLocalOnly = true, ssh = null,
  } = state;
  const lines = [version ? `Rooks ${version}` : 'Rooks', ''];
  const row = (label, value) => lines.push(`  ${label.padEnd(15)}${value}`);

  if (!reachable) {
    row('Daemon', `not answering at ${api}`);
    if (local) row('Service', serviceInstalled ? 'installed' : 'not installed');
    lines.push('');
    if (!local) {
      lines.push('Check the address, and that the machine is on and runs Rooks.');
    } else if (serviceInstalled) {
      lines.push('Next: see why the service does not answer');
      lines.push('  rooks service status');
      lines.push('  rooks doctor');
    } else {
      lines.push('Next: run Rooks in the background (starts at boot, keeps running after you log out)');
      lines.push('  rooks service install');
      lines.push('Or open the Rooks app on this machine.');
    }
    lines.push('', 'All commands: rooks help');
    return lines;
  }

  row('Daemon', `running at ${api}`);
  row('Account', needsSetup === true ? 'not created yet' : needsSetup === false ? 'created' : 'unknown');
  if (appUrl) row('Web interface', appLocalOnly ? `${appUrl} (this machine only)` : appUrl);

  const next = [];
  if (needsSetup === true) {
    next.push('Next: create your account', '  rooks init');
    if (appUrl && !ssh) next.push(`Or open ${appUrl} in a browser.`);
  } else if (appUrl && ssh && appLocalOnly) {
    const port = new URL(appUrl).port || '80';
    next.push(
      'Open the web interface from your computer through an SSH tunnel:',
      `  ssh -N -L ${port}:127.0.0.1:${port} ${ssh.user}@${ssh.host}`,
      `  then http://127.0.0.1:${port}`,
    );
  } else if (appUrl) {
    next.push(`Open ${appUrl} in a browser.`);
  }
  if (next.length) lines.push('', ...next);
  lines.push('', 'All commands: rooks help');
  return lines;
}

/** `http://host:port` of a listener, the loopback standing in for a wildcard. */
export function listenUrl(listen) {
  if (!listen || typeof listen.port !== 'number') return null;
  let host = typeof listen.host === 'string' && listen.host ? listen.host : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return new URL(`http://${authority}:${listen.port}`).origin;
  } catch {
    return null;
  }
}

export function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host ?? '');
}

/**
 * The AI command-line tools of `GET /api/host/provider-clis` (`SetupBackend`
 * of `src/onboarding.ts`), told from the terminal: what is ready, what to
 * sign in, and what to install when nothing is there.
 */
export function aiToolLines(backends) {
  const list = Array.isArray(backends) ? backends : [];
  const found = list.filter((b) => b && typeof b.path === 'string' && b.path);
  const lines = ['AI tools (your agents work through them, under this account):'];
  const signIn = (b) => `${b.signInCommand}${b.signInThen ? `, then ${b.signInThen}` : ''}`;
  for (const b of found) {
    const label = String(b.label ?? b.name).padEnd(14);
    if (b.signedIn === true) lines.push(`  ${label}ready`);
    else if (b.signedIn === false) lines.push(`  ${label}not signed in: ${signIn(b)}`);
    else lines.push(`  ${label}found; to sign in: ${signIn(b)}`);
  }
  if (!found.length) {
    lines.push('  None found. Install one, then sign in to it:');
    for (const b of list.filter((entry) => entry?.seedsMainAgent)) {
      const how = b.installCommand ?? b.installDocs;
      if (how) lines.push(`  ${String(b.label ?? b.name).padEnd(14)}${how}`);
    }
  }
  return lines;
}
