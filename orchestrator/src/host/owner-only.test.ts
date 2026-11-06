import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  hasForeignAce,
  isOwnerOnlyDirDacl,
  ownerOnlyDirSddl,
  ownerOnlyMode,
  parseDacl,
  prepareOwnerOnlyFile,
  restrictHomeAclToOwner,
  tightenToOwner,
  type SyncExec,
} from './owner-only.js';

const posix = process.platform !== 'win32';
const modeOf = (path: string) => statSync(path).mode & 0o777;
const scratch = () => mkdtempSync(join(tmpdir(), 'timon-owner-only-'));

test('ownerOnlyMode clears group and other bits and adds nothing', () => {
  assert.equal(ownerOnlyMode(0o100644), 0o600);
  assert.equal(ownerOnlyMode(0o40775), 0o700);
  assert.equal(ownerOnlyMode(0o400), 0o400);
  assert.equal(ownerOnlyMode(0o200), 0o200);
});

test('a database prepared owner-only gets owner-only -wal and -shm from SQLite', { skip: !posix }, () => {
  const path = join(scratch(), 'timon.db');
  // The worst umask a user may have: the mode must not depend on it.
  const previous = process.umask(0o002);
  try {
    assert.equal(prepareOwnerOnlyFile(path), 'unchanged');
    const db = new Database(path);
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'x\')');
      assert.equal(modeOf(path), 0o600);
      assert.equal(modeOf(`${path}-wal`), 0o600);
      assert.equal(modeOf(`${path}-shm`), 0o600);
    } finally {
      db.close();
    }
  } finally {
    process.umask(previous);
  }
});

test('preparing an existing database neither truncates it nor leaves it 0644', { skip: !posix }, () => {
  const path = join(scratch(), 'timon.db');
  writeFileSync(path, 'content', { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.equal(prepareOwnerOnlyFile(path), 'tightened');
  assert.equal(modeOf(path), 0o600);
  assert.equal(readFileSync(path, 'utf8'), 'content');
});

test('an existing read-only database is still tightened', { skip: !posix }, () => {
  const path = join(scratch(), 'timon.db');
  writeFileSync(path, 'content');
  chmodSync(path, 0o444);
  assert.equal(prepareOwnerOnlyFile(path), 'tightened');
  assert.equal(modeOf(path), 0o400);
});

test('an existing 0644 file is tightened to 0600, a 0755 directory to 0700', { skip: !posix }, () => {
  const dir = scratch();
  const file = join(dir, 'timon.db-wal');
  writeFileSync(file, '');
  chmodSync(file, 0o644);
  const sub = join(dir, 'backups');
  mkdirSync(sub);
  chmodSync(sub, 0o755);
  assert.equal(tightenToOwner(file), 'tightened');
  assert.equal(tightenToOwner(sub), 'tightened');
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(sub), 0o700);
});

test('permissions are never widened: 0400 stays 0400, 0600 is not touched', { skip: !posix }, () => {
  const dir = scratch();
  const readOnly = join(dir, 'license.key');
  writeFileSync(readOnly, 'k');
  chmodSync(readOnly, 0o400);
  const already = join(dir, 'secret-key');
  writeFileSync(already, 's');
  chmodSync(already, 0o600);
  let chmods = 0;
  const chmod = (path: string, mode: number) => { chmods += 1; chmodSync(path, mode); };
  assert.equal(tightenToOwner(readOnly, { chmod }), 'unchanged');
  assert.equal(tightenToOwner(already, { chmod }), 'unchanged');
  assert.equal(chmods, 0);
  assert.equal(modeOf(readOnly), 0o400);
  // 0440 loses the group bit and keeps the owner's read-only bit: no write gained.
  const groupRead = join(dir, 'device-id');
  writeFileSync(groupRead, 'd');
  chmodSync(groupRead, 0o440);
  assert.equal(tightenToOwner(groupRead), 'tightened');
  assert.equal(modeOf(groupRead), 0o400);
});

test('a missing path is not a failure', () => {
  assert.equal(tightenToOwner(join(scratch(), 'remote.db'), { platform: 'linux' }), 'missing');
});

test('a chmod that throws is logged and tolerated', () => {
  const warnings: string[] = [];
  const outcome = tightenToOwner('/data/timon.db', {
    platform: 'linux',
    stat: () => ({ mode: 0o100644 }) as ReturnType<typeof statSync>,
    chmod: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(outcome, 'failed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^\[perms\] cannot restrict .*timon\.db.*operation not permitted/);
});

test('an unreadable path is logged and tolerated', () => {
  const warnings: string[] = [];
  const outcome = tightenToOwner('/data/timon.db', {
    platform: 'darwin',
    stat: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
    warn: (message) => warnings.push(message),
  });
  assert.equal(outcome, 'failed');
  assert.equal(warnings.length, 1);
});

test('a file that cannot be created is logged and tolerated', () => {
  const warnings: string[] = [];
  const outcome = prepareOwnerOnlyFile(join(scratch(), 'missing-dir', 'timon.db'), {
    platform: 'linux',
    warn: (message) => warnings.push(message),
  });
  assert.equal(outcome, 'failed');
  assert.match(warnings[0]!, /cannot create .* owner-only/);
});

test('under win32 no POSIX mode is touched', () => {
  let touched = false;
  const deps = {
    platform: 'win32' as const,
    stat: () => { touched = true; return { mode: 0o100644 } as ReturnType<typeof statSync>; },
    chmod: () => { touched = true; },
  };
  assert.equal(tightenToOwner('C:\\Users\\robin\\.timon\\timon.db', deps), 'skipped');
  assert.equal(prepareOwnerOnlyFile('C:\\Users\\robin\\.timon\\timon.db', deps), 'skipped');
  assert.equal(touched, false);
});

const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const HOME = 'D:\\Timon';
const DB = 'D:\\Timon\\timon.db';
const TOKEN = 'D:\\Timon\\daemon-token';
/** What a home outside the profile typically inherits from a `D:\` root. */
const WIDE_DIR = `D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;OICIIOID;GA;;;CO)(A;OICIID;FA;;;${SID})`;
const INHERITED_OWNER_ONLY = `D:AI(A;ID;FA;;;${SID})(A;ID;FA;;;SY)`;

/**
 * A fake ACL store driven the way the adapter drives PowerShell: the read
 * script gets `TIMON_ACL_PATHS`, the apply script `TIMON_ACL_HOME`. Applying the
 * DACL propagates to the files that only inherit; `/reset` drops explicit entries.
 */
function aclStore(initial: Record<string, string>, opts: { applyCode?: number; applyTimedOut?: boolean; applyNoop?: boolean } = {}) {
  const store = new Map(Object.entries(initial));
  const calls: { kind: 'read' | 'apply'; env: NodeJS.ProcessEnv; args: string[] }[] = [];
  const exec: SyncExec = (file, args, { env }) => {
    assert.equal(file, 'powershell.exe');
    if (env.TIMON_ACL_PATHS !== undefined) {
      calls.push({ kind: 'read', env, args });
      const lines = [SID, ...env.TIMON_ACL_PATHS.split('\n').map((p, i) => `${i}\t${store.get(p) ?? '-'}`)];
      return { code: 0, stdout: `${lines.join('\r\n')}\r\n`, stderr: '' };
    }
    calls.push({ kind: 'apply', env, args });
    if (!opts.applyNoop) {
      if (env.TIMON_ACL_SDDL) {
        store.set(env.TIMON_ACL_HOME!, env.TIMON_ACL_SDDL);
        for (const [path, sddl] of store) {
          if (path !== env.TIMON_ACL_HOME && (parseDacl(sddl)?.aces ?? []).every((ace) => ace.flags.includes('ID'))) store.set(path, INHERITED_OWNER_ONLY);
        }
      }
      for (const path of (env.TIMON_ACL_RESET ?? '').split('\n').filter(Boolean)) store.set(path, INHERITED_OWNER_ONLY);
    }
    return { code: opts.applyCode ?? 0, stdout: '', stderr: opts.applyCode ? 'Access is denied.' : '', ...(opts.applyTimedOut ? { timedOut: true } : {}) };
  };
  return { store, calls, exec };
}

const quiet = () => {
  const warnings: string[] = [];
  return { warnings, warn: (m: string) => warnings.push(m), log: () => {} };
};
const decoded = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');

test('parseDacl reads flags, entries and trustees of an SDDL string', () => {
  const dacl = parseDacl(`O:${SID}G:${SID}D:P(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)`);
  assert.equal(dacl?.flags, 'P');
  assert.deepEqual(dacl?.aces.map((a) => [a.type, a.flags.join(''), a.trustee]), [['A', 'OICI', SID], ['A', 'OICI', 'SY']]);
  assert.equal(parseDacl(`O:${SID}G:${SID}`), null, 'no DACL at all');
});

test('only the protected account + LocalSystem DACL counts as owner-only', () => {
  assert.equal(isOwnerOnlyDirDacl(ownerOnlyDirSddl(SID), SID), true);
  assert.equal(isOwnerOnlyDirDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${SID})`, SID), true, 'order does not matter');
  assert.equal(isOwnerOnlyDirDacl(WIDE_DIR, SID), false, 'inherited, not protected');
  // What `icacls /inheritance:r /grant:r` alone would have left: explicit Users and Everyone kept.
  assert.equal(isOwnerOnlyDirDacl(`D:P(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)`, SID), false);
  assert.equal(isOwnerOnlyDirDacl(`D:P(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;;FR;;;WD)`, SID), false);
  assert.equal(isOwnerOnlyDirDacl('D:P(A;OICI;FA;;;SY)', SID), false, 'the account itself must be granted');
  assert.equal(isOwnerOnlyDirDacl(`D:P(A;OICIIO;FA;;;${SID})(A;OICI;FA;;;SY)`, SID), false, 'inherit-only gives the dir nothing');
  assert.equal(hasForeignAce(INHERITED_OWNER_ONLY, SID), false);
  assert.equal(hasForeignAce(`D:AI(A;;FR;;;WD)(A;ID;FA;;;${SID})`, SID), true);
  assert.equal(hasForeignAce('D:NO_ACCESS_CONTROL', SID), true, 'a NULL DACL grants everyone');
  // A conditional ACE has its own parentheses: whatever follows it must not be lost.
  const conditional = `D:P(A;OICI;FA;;;${SID})(XA;;FR;;;WD;(@User.x == "y"))(A;OICI;FA;;;SY)(A;;FR;;;BU)`;
  assert.equal(parseDacl(conditional), null);
  assert.equal(isOwnerOnlyDirDacl(conditional, SID), false);
  assert.equal(hasForeignAce(conditional, SID), true);
  assert.notEqual(parseDacl(`${ownerOnlyDirSddl(SID)}S:AI(AU;SA;FA;;;WD)`), null, 'a SACL after the DACL is fine');
});

test('under win32 explicit Users / Everyone entries are removed from the home and the database', () => {
  const { store, calls, exec } = aclStore({
    [HOME]: `D:P(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICI;FR;;;WD)`,
    [DB]: `D:AI(A;;FR;;;WD)(A;ID;FA;;;${SID})(A;ID;FA;;;SY)`,
    [TOKEN]: `D:AI(A;ID;FA;;;${SID})(A;ID;FA;;;SY)(A;ID;0x1200a9;;;BU)`,
  });
  const q = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [DB, TOKEN, 'D:\\Timon\\remote.db'], { exec, ...q }), 'tightened');
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'apply', 'read']);
  assert.equal(calls[1]!.env.TIMON_ACL_SDDL, ownerOnlyDirSddl(SID));
  // The explicit Everyone entry on the database cannot be reached from the home: it is reset.
  assert.deepEqual(calls[1]!.env.TIMON_ACL_RESET!.split('\n'), [DB, TOKEN]);
  assert.equal(isOwnerOnlyDirDacl(store.get(HOME)!, SID), true);
  assert.equal(hasForeignAce(store.get(DB)!, SID), false);
  assert.equal(hasForeignAce(store.get(TOKEN)!, SID), false);
  assert.deepEqual(q.warnings, []);
  // Paths go through the environment, never into the script text.
  assert.match(decoded(calls[0]!.args), /Get-Acl -LiteralPath \$p/);
  assert.doesNotMatch(decoded(calls[0]!.args), /Timon/);
  assert.match(decoded(calls[1]!.args), /SetAccessControl\(\$env:TIMON_ACL_HOME/);
});

test('under win32 a canonical ACL is read at every start and left alone', () => {
  const { calls, exec } = aclStore({ [HOME]: ownerOnlyDirSddl(SID), [DB]: INHERITED_OWNER_ONLY });
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec, ...quiet() }), 'unchanged');
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec, ...quiet() }), 'unchanged');
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'read']);
});

test('under win32 an ACL widened again between two starts is restricted again', () => {
  const { store, calls, exec } = aclStore({ [HOME]: WIDE_DIR, [DB]: `D:AI(A;OICIID;FA;;;${SID})(A;OICIID;0x1200a9;;;BU)` });
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec, ...quiet() }), 'tightened');
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec, ...quiet() }), 'unchanged');
  // Someone runs `icacls D:\Timon /grant *S-1-1-0:R` and grants Users on the database.
  store.set(HOME, `${store.get(HOME)!}(A;;FR;;;WD)`);
  store.set(DB, `${store.get(DB)!}(A;;FR;;;BU)`);
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec, ...quiet() }), 'tightened');
  assert.deepEqual(calls.map((c) => c.kind), ['read', 'apply', 'read', 'read', 'read', 'apply', 'read']);
  assert.equal(isOwnerOnlyDirDacl(store.get(HOME)!, SID), true);
  assert.equal(hasForeignAce(store.get(DB)!, SID), false);
});

test('under win32 a failed or cut-short rewrite is judged on what is in place, logged, never thrown', () => {
  const denied = aclStore({ [HOME]: WIDE_DIR }, { applyCode: 5, applyNoop: true });
  const q1 = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [], { exec: denied.exec, ...q1 }), 'failed');
  assert.match(q1.warnings[0]!, /failed \(exit 5\): Access is denied/);
  assert.match(q1.warnings[1]!, /still grant another account/);

  // Timed out after the home was rewritten: the home is fine, the database still is not.
  const cut = aclStore({ [HOME]: WIDE_DIR, [DB]: `D:AI(A;;FR;;;WD)(A;ID;FA;;;${SID})` }, { applyTimedOut: true });
  const q2 = quiet();
  const realExec = cut.exec;
  const exec: SyncExec = (file, args, opts) => {
    const res = realExec(file, args, opts);
    if (opts.env.TIMON_ACL_HOME) cut.store.set(DB, `D:AI(A;;FR;;;WD)(A;ID;FA;;;${SID})`);
    return res;
  };
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec, ...q2 }), 'failed');
  assert.match(q2.warnings[0]!, /timed out, the next start carries on/);
  // Next start: the home is canonical, the database alone is reset.
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec: realExec, ...quiet() }), 'tightened');
  assert.equal(cut.calls.at(-2)!.env.TIMON_ACL_SDDL, '');
  assert.equal(cut.calls.at(-2)!.env.TIMON_ACL_RESET, DB);
});

test('under win32 an unreadable ACL, an unknown account or a throwing exec is tolerated', () => {
  const fat = aclStore({ [HOME]: '!' });
  const q1 = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [], { exec: fat.exec, ...q1 }), 'failed');
  assert.match(q1.warnings[0]!, /cannot read the ACL of D:\\Timon/);
  assert.deepEqual(fat.calls.map((c) => c.kind), ['read'], 'nothing is applied blind');

  const q2 = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [], { exec: () => ({ code: 0, stdout: 'garbage', stderr: '' }), ...q2 }), 'failed');
  assert.match(q2.warnings[0]!, /cannot resolve the current Windows account/);

  const q3 = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [], { exec: () => ({ code: 1, stdout: '', stderr: '', timedOut: true }), ...q3 }), 'failed');
  assert.match(q3.warnings[0]!, /reading the ACLs timed out/);

  const system = quiet();
  const asSystem: SyncExec = () => ({ code: 0, stdout: `S-1-5-18\r\n0\t${WIDE_DIR}\r\n`, stderr: '' });
  assert.equal(restrictHomeAclToOwner(HOME, [], { exec: asSystem, ...system }), 'failed');
  assert.match(system.warnings[0]!, /runs as a service account/);

  const unreadable = aclStore({ [HOME]: ownerOnlyDirSddl(SID), [DB]: '!' });
  const q5 = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [DB], { exec: unreadable.exec, ...q5 }), 'unchanged');
  assert.match(q5.warnings[0]!, /cannot read the ACL of 1 path\(s\)/);

  const q4 = quiet();
  assert.equal(restrictHomeAclToOwner(HOME, [], { exec: () => { throw new Error('spawn powershell.exe ENOENT'); }, ...q4 }), 'failed');
  assert.match(q4.warnings[0]!, /spawn powershell\.exe ENOENT/);
});
