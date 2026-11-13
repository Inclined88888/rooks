/**
 * macOS code signature of a packaged Rooks.app, read with `codesign`.
 *
 * Apple Silicon kills at launch an app whose signature does not match its
 * code (SIGKILL, Code Signature Invalid) — 0.1.1-rc.1 shipped that way and the
 * build said nothing. Both `npm run dist` (afterPack) and `build-rc.mjs` check
 * the bundle with this module so a broken signature fails the build instead.
 *
 * No dependency: `build-rc.mjs` imports it from the repository root, where
 * desktop/node_modules may not be installed.
 */
import { spawnSync } from 'node:child_process';

/**
 * Reads `codesign -dv` output (it prints on stderr). A Developer ID signature
 * names its authority; without one electron-builder skips signing and the app
 * keeps Electron's ad-hoc signature, which Gatekeeper does not trust.
 */
export function parseSignatureDetails(details) {
  const authority = /^Authority=(.+)$/m.exec(details)?.[1] ?? null;
  if (/^Signature=adhoc$/m.test(details)) return { kind: 'adhoc', authority: null };
  if (authority?.startsWith('Developer ID Application:')) return { kind: 'developer-id', authority };
  return { kind: authority ? 'other' : 'unsigned', authority };
}

export function describeSignature({ kind, authority }) {
  if (kind === 'developer-id') return `Developer ID (${authority})`;
  if (kind === 'adhoc') return 'ad-hoc, no Developer ID identity: Gatekeeper blocks the first launch, right-click the app then Open';
  if (kind === 'other') return `signed by ${authority}, not a Developer ID: Gatekeeper will not trust it`;
  return 'unsigned: Apple Silicon refuses to launch it';
}

/** Verifies the bundle as the loader will, then says how it is signed. Throws when the signature is broken. */
export function checkMacSignature(appPath) {
  // portability: codesign exists on macOS only, and this only runs when packaging for macOS on a Mac
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' });
  if (verify.error) throw new Error(`codesign: ${verify.error.message}`);
  if (verify.status !== 0) {
    throw new Error(`${appPath} has a broken code signature; Apple Silicon kills it at launch (SIGKILL, Code Signature Invalid).\n${verify.stderr.trim()}`);
  }
  // portability: same as above, macOS-only packaging step
  const details = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' });
  if (details.error) throw new Error(`codesign: ${details.error.message}`);
  return parseSignatureDetails(`${details.stdout}\n${details.stderr}`);
}
