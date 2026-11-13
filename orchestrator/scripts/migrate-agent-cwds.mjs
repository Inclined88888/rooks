#!/usr/bin/env node
/**
 * One-shot migration helper for the container → host transition.
 *
 * When ROOKS ran inside docker, the orchestrator (and the agents it
 * spawned) executed as root inside a Debian image. Three artefacts of
 * that setup break when you flip to host mode and don't get cleaned up
 * automatically:
 *
 *   1. Agent configs at ~/.rooks/agents/<name>/config.json have `cwd`
 *      values rooted at `/workspace`, an alias that only existed inside
 *      the container. On the host, the equivalent is `$HOME/webdev`
 *      (the source of the old mount).
 *
 *   2. ROOKS state files (db, agents/, mcp/, …) and Claude session
 *      jsonl files (~/.claude/projects/*) and Codex auth dirs
 *      (~/.codex) are still owned by root because docker wrote them
 *      that way through the bind mount. Reading them as your user
 *      fails with EACCES and Claude reports "No conversation found".
 *
 *   3. Claude indexes its sessions per-project by transforming the
 *      cwd into a directory name (`/workspace/projects/foo` →
 *      `-workspace-projects-foo`). After migrating the agent cwds,
 *      those dirs need to be renamed to the new host-path key
 *      otherwise `--resume <sid>` can't find the conversation.
 *
 * This script handles all three in one shot:
 *
 *   node migrate-agent-cwds.mjs              # dry run, prints diff
 *   node migrate-agent-cwds.mjs --write      # apply
 *
 * Idempotent: re-runs on an already-migrated setup are no-ops. The
 * ownership step needs sudo OR a running container with the relevant
 * dirs bind-mounted (we use the latter via `docker run --rm`). If
 * neither is available, the script prints the commands you need to
 * run manually and exits.
 */
import {
  existsSync, readFileSync, readdirSync, renameSync, statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const ROOKS_HOME = process.env.ROOKS_HOME || join(HOME, '.rooks');
const AGENTS = join(ROOKS_HOME, 'agents');
const HOST_WORKSPACE = process.env.ROOKS_HOST_WORKSPACE || join(HOME, 'webdev');
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');

const write = process.argv.includes('--write');

if (!existsSync(AGENTS)) {
  console.log(`no agents dir at ${AGENTS} — nothing to migrate.`);
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────
// 1) Rewrite /workspace cwd values in agent configs
// ────────────────────────────────────────────────────────────────────
console.log('\n[1/3] agent.cwd rewrites — /workspace/... → ' + HOST_WORKSPACE + '/...');
let cfgTouched = 0;
let cfgUnchanged = 0;
const migratedCwds = new Set(); // collected for step 3
for (const name of readdirSync(AGENTS)) {
  const cfgPath = join(AGENTS, name, 'config.json');
  if (!existsSync(cfgPath)) continue;
  if (!statSync(cfgPath).isFile()) continue;
  let cfg;
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
  catch { console.warn(`  skip ${name}: invalid JSON`); continue; }
  const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : '';
  if (cwd && cwd.startsWith('/workspace')) {
    const next = cwd === '/workspace'
      ? HOST_WORKSPACE
      : HOST_WORKSPACE + cwd.slice('/workspace'.length);
    console.log(`  ${name}: ${cwd} → ${next}`);
    if (write) {
      cfg.cwd = next;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    }
    cfgTouched++;
    migratedCwds.add(cwd);
  } else {
    cfgUnchanged++;
    // Track the existing cwd too — Claude session dirs may still need
    // a rename if the agent's cwd points outside /workspace but the
    // session was originally indexed there.
    if (cwd) migratedCwds.add(cwd);
  }
}
console.log(`  ${cfgTouched} rewritten, ${cfgUnchanged} unchanged.`);

// ────────────────────────────────────────────────────────────────────
// 2) Reclaim ownership of ROOKS state + auth dirs from root
// ────────────────────────────────────────────────────────────────────
console.log('\n[2/3] ownership reclaim (root → ' + process.getuid() + ':' + process.getgid() + ')');
const ownDirs = [
  ROOKS_HOME,
  join(HOME, '.claude'),
  join(HOME, '.codex'),
].filter((d) => existsSync(d));

const rootOwned = ownDirs.filter((d) => {
  try { return statSync(d).uid === 0 || hasRootChildren(d); }
  catch { return false; }
});

function hasRootChildren(dir) {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (statSync(p).uid === 0) return true; } catch {}
    }
  } catch {}
  return false;
}

if (rootOwned.length === 0) {
  console.log('  nothing root-owned — skipping.');
} else {
  for (const d of rootOwned) console.log('  needs chown: ' + d);
  if (write) {
    const uid = process.getuid();
    const gid = process.getgid();
    // Prefer docker run --rm (no sudo needed if user is in `docker`
    // group). Fall back to instructing the user.
    let ok = true;
    try {
      const mounts = rootOwned.flatMap((d, i) => ['-v', `${d}:/m${i}`]);
      const chowns = rootOwned.map((_, i) => `chown -R ${uid}:${gid} /m${i}`).join(' && ');
      execFileSync(
        'docker',
        ['run', '--rm', ...mounts, 'alpine', 'sh', '-c', chowns],
        { stdio: 'pipe' },
      );
      console.log('  chowned via `docker run --rm alpine` OK');
    } catch (err) {
      ok = false;
      console.warn('  docker chown failed — run manually:');
      for (const d of rootOwned) console.warn(`    sudo chown -R ${uid}:${gid} ${d}`);
      console.warn('  (' + (err.message || err) + ')');
    }
    if (!ok) process.exitCode = 1;
  }
}

// ────────────────────────────────────────────────────────────────────
// 3) Rename Claude project dirs so --resume keeps finding sessions
// ────────────────────────────────────────────────────────────────────
console.log('\n[3/3] Claude session dir renames (~/.claude/projects/-workspace... → -<host-path>...)');
if (!existsSync(CLAUDE_PROJECTS)) {
  console.log('  no ~/.claude/projects — skipping.');
} else {
  const safe = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
  let renamed = 0;
  for (const dir of readdirSync(CLAUDE_PROJECTS)) {
    if (!dir.startsWith('-workspace')) continue;
    // Map -workspace-projects-foo → /workspace/projects/foo
    const orig = '/' + dir.slice(1).replace(/-/g, '/');
    const next = orig === '/workspace'
      ? HOST_WORKSPACE
      : HOST_WORKSPACE + orig.slice('/workspace'.length);
    const targetDir = safe(next);
    const from = join(CLAUDE_PROJECTS, dir);
    const to = join(CLAUDE_PROJECTS, targetDir);
    console.log(`  ${dir} → ${targetDir}`);
    if (write) {
      if (existsSync(to)) {
        console.warn(`    refusing to overwrite existing ${targetDir}`);
        continue;
      }
      renameSync(from, to);
      renamed++;
    }
  }
  console.log(`  ${renamed} renamed.`);
}

if (!write) {
  console.log('\n(dry run — re-run with --write to apply all three steps)');
} else {
  console.log('\ndone.');
}
