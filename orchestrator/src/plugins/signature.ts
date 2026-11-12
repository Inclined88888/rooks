import { createHash, verify as verifyCrypto } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { PLUGIN_PUBLIC_KEYS, type PluginPublicKey } from './pubkey.js';

export const PluginSignatureSchema = z.object({
  alg: z.literal('ed25519'),
  keyId: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  sig: z.string().min(1),
});
export type PluginSignature = z.infer<typeof PluginSignatureSchema>;

function filesBelow(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(root, path));
    else if (entry.isFile() && !(dir === root && entry.name === 'SIGNATURE')) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`symbolic link forbidden in a signed plugin: ${relative(root, path)}`);
  }
  return files;
}

/** The path is part of the digest: renaming a file alters the package. */
export function hashPluginDirectory(root: string): string {
  const hash = createHash('sha256');
  const files = filesBelow(root).sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  for (const file of files) {
    const name = relative(root, file).split(sep).join('/');
    hash.update(name, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export type SignatureResult =
  | { ok: true; signature: PluginSignature }
  | { ok: false; code: 'unsigned' | 'tampered'; message: string };

export function verifyPluginDirectory(
  root: string,
  keys: readonly PluginPublicKey[] = PLUGIN_PUBLIC_KEYS,
  now = new Date(),
): SignatureResult {
  const file = join(root, 'SIGNATURE');
  if (!existsSync(file)) return { ok: false, code: 'unsigned', message: 'SIGNATURE absent' };
  let signature: PluginSignature;
  try {
    signature = PluginSignatureSchema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch (err) {
    return { ok: false, code: 'unsigned', message: `invalid SIGNATURE: ${(err as Error).message}` };
  }
  const key = keys.find((candidate) => candidate.keyId === signature.keyId);
  if (!key) return { ok: false, code: 'unsigned', message: `unknown signing key: ${signature.keyId}` };
  if (key.expiresAt) {
    const expiry = Date.parse(key.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
      return { ok: false, code: 'unsigned', message: `expired signing key: ${signature.keyId}` };
    }
  }
  let actual: string;
  try { actual = hashPluginDirectory(root); }
  catch (err) { return { ok: false, code: 'tampered', message: `package cannot be verified: ${(err as Error).message}` }; }
  if (actual !== signature.hash) {
    return { ok: false, code: 'tampered', message: `package hash differs (expected ${signature.hash}, got ${actual})` };
  }
  try {
    const valid = verifyCrypto(null, Buffer.from(signature.hash, 'hex'), key.publicKey, Buffer.from(signature.sig, 'base64'));
    return valid
      ? { ok: true, signature }
      : { ok: false, code: 'tampered', message: `invalid Ed25519 signature for key ${signature.keyId}` };
  } catch (err) {
    return { ok: false, code: 'tampered', message: `signature cannot be checked: ${(err as Error).message}` };
  }
}
