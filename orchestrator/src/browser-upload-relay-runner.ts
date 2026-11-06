/**
 * Entry point of the `upload_file` path relay (`browser-upload-relay.ts`):
 * declared by the daemon as the `timon-browser` MCP server on Windows, it
 * starts the real `chrome-devtools-mcp` and stands between it and the CLI.
 */
import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import { windowsShimLaunch } from './host/windows-shell.js';
import { UPLOAD_RELAY_SPEC_ENV, parseUploadRelaySpec, relayClientLine } from './browser-upload-relay.js';

const spec = parseUploadRelaySpec(process.env[UPLOAD_RELAY_SPEC_ENV]);
const env = { ...process.env };
delete env[UPLOAD_RELAY_SPEC_ENV];
delete env.ELECTRON_RUN_AS_NODE;

// `npx` is an npm shim (`npx.cmd`) on Windows, which Node only starts through cmd.exe.
const file = process.platform === 'win32' && !extname(spec.command) ? `${spec.command}.cmd` : spec.command;
const launch = windowsShimLaunch(file, spec.args);
const child = spawn(launch?.file ?? file, launch?.args ?? spec.args, {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
  windowsVerbatimArguments: launch?.windowsVerbatimArguments ?? false,
});
child.once('error', (err) => {
  console.error(`[timon-browser] cannot start ${spec.command}: ${err.message}`);
  process.exit(1);
});
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Whole lines only, on both sides: a direct reply must never land in the middle
// of a server message.
createInterface({ input: child.stdout, crlfDelay: Infinity })
  .on('line', (line) => { process.stdout.write(`${line}\n`); });
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (!line.trim()) return;
    const decision = relayClientLine(line, spec);
    if ('reply' in decision) process.stdout.write(`${decision.reply}\n`);
    else child.stdin.write(`${decision.forward}\n`);
  })
  .on('close', () => child.stdin.end());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { child.kill(signal); });
}
