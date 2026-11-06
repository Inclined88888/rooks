/**
 * Shared harness of the MCP ↔ CLI parity tests (docs/AUDIT-CLI-VS-MCP.md): a
 * stub daemon that records the calls, one MCP process per session, one CLI
 * process per command. Split out of src/mcp-cli-parity.test.ts so the tests
 * can live in two files, each under the runner's per-file limit.
 */
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

export const MCP = fileURLToPath(new URL('../../bin/timon-mcp.mjs', import.meta.url));
export const CLI = fileURLToPath(new URL('../../bin/timon', import.meta.url));

export type Seen = { method: string; url: string; body: Record<string, unknown> };
export type Reply = { id: number; result?: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } };

/** One MCP process, several requests: answers keyed by id. */
export async function session(base: string, requests: Array<Record<string, unknown>>, withMission = false, extraEnv: NodeJS.ProcessEnv = {}): Promise<Reply[]> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-mcp-parity-')),
    TIMON_API_TOKEN: 'test-token',
    TIMON_ORCH_URL: base,
  };
  delete env.TIMON_TRACE_ID;
  delete env.TIMON_MISSION_ID;
  delete env.TIMON_PROJECT;
  delete env.TIMON_WORKFLOW_RUN_ID;
  delete env.TIMON_WORKFLOW_NODE_ID;
  if (withMission) env.TIMON_MISSION_ID = 'mission-parent';
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies: Reply[] = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 15_000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      replies.push(JSON.parse(line));
      if (replies.length === requests.length) { clearTimeout(timer); child.kill(); lines.close(); resolve(replies); }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.end(requests.map((r, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...r })).join('\n') + '\n');
  });
}

/** One CLI process: runs `timon <argv...>` against the stub, returns exit code + output. */
export async function cli(base: string, argv: string[], envExtra: NodeJS.ProcessEnv = {}, input?: string): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-cli-parity-')),
    TIMON_API_TOKEN: 'test-token',
    TIMON_API: base,
  };
  delete env.TIMON_TRACE_ID;
  delete env.TIMON_MISSION_ID;
  delete env.TIMON_AGENT;
  delete env.TIMON_PROJECT;
  Object.assign(env, envExtra);
  const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  if (input !== undefined) child.stdin.end(input);
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += String(c); });
  child.stderr.on('data', (c: Buffer) => { err += String(c); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 15_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, out: out + err }); });
  });
}

/** `answer` replaces the stub's catch-all 200, to see how a client renders a given reply. */
export async function withDaemon(fn: (base: string, seen: Seen[]) => Promise<void>, answer?: { status: number; body: Record<string, unknown> }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer | string) => { raw += String(c); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
      res.writeHead(answer?.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer?.body ?? {
        ok: true, status: 'done', skills: [], servers: [], tasks: [], routines: [], pipelines: [], sessions: [],
        files: [], projects: [], roles: {}, events: [], task: { id: 't1' }, pipeline: { id: 'p1' }, routine: { id: 'r1' },
        message: { from_agent: 'sender', from_mission: 'm1' }, session: { status: 'running' }, worktree: { path: 'w' },
        mission_id: 'new-mission', missionId: 'forked', content: 'body', backends: [], notification: { id: 'n1' },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); }
  finally { server.closeAllConnections(); server.close(); }
}
