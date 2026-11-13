import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DICTATION_PACK_BYTES, MAX_DICTATION_PACK_MODELS, readDictationPack } from './dictation-packs.js';

const manifest = (models?: string) => ({ kind: ['dictation'] as string[], dictation: { engines: [], ...(models ? { models } : {}) } });

function withPackage(body: (dir: string, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'rooks-dictation-pack-'));
  const dir = join(root, 'pkg');
  mkdirSync(dir);
  try { body(dir, root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a pack is read from the package: its entries, nothing else', () => {
  withPackage((dir) => {
    writeFileSync(join(dir, 'dictation-models.json'), JSON.stringify({ $schema: 'x', models: [{ id: 'acme.tiny' }] }));
    assert.deepEqual(readDictationPack(dir, manifest('dictation-models.json')), { ok: true, models: [{ id: 'acme.tiny' }] });
  });
});

test('no pack: another kind, no `models`, no manifest', () => {
  withPackage((dir) => {
    writeFileSync(join(dir, 'dictation-models.json'), JSON.stringify({ models: [{ id: 'acme.tiny' }] }));
    assert.equal(readDictationPack(dir, null).ok, false);
    assert.deepEqual(readDictationPack(dir, manifest()), { ok: false, code: 'no-pack', message: 'This plugin declares no speech models.' });
    const widget = { kind: ['widget'], dictation: { engines: [], models: 'dictation-models.json' } };
    assert.equal((readDictationPack(dir, widget) as { code: string }).code, 'no-pack');
  });
});

test('a pack that leaves the package, is missing or is not a file is refused', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  withPackage((dir, root) => {
    assert.equal((readDictationPack(dir, manifest('dictation-models.json')) as { code: string }).code, 'outside');
    writeFileSync(join(root, 'secret.json'), JSON.stringify({ models: [{ id: 'acme.tiny' }] }));
    symlinkSync(join(root, 'secret.json'), join(dir, 'dictation-models.json'));
    assert.equal((readDictationPack(dir, manifest('dictation-models.json')) as { code: string }).code, 'outside');
    mkdirSync(join(dir, 'folder.json'));
    assert.equal((readDictationPack(dir, manifest('folder.json')) as { code: string }).code, 'outside');
  });
});

test('a pack too large, not JSON, or not shaped like a pack is refused', () => {
  withPackage((dir) => {
    const file = join(dir, 'dictation-models.json');
    const read = () => readDictationPack(dir, manifest('dictation-models.json')) as { ok: boolean; code?: string };
    writeFileSync(file, ' '.repeat(MAX_DICTATION_PACK_BYTES + 1));
    assert.equal(read().code, 'too-large');
    writeFileSync(file, '{ models: ');
    assert.equal(read().code, 'invalid');
    for (const bad of [[], {}, { models: [] }, { models: ['x'] }, { models: [{ id: 'a' }], extra: true },
      { models: Array.from({ length: MAX_DICTATION_PACK_MODELS + 1 }, (_, i) => ({ id: `a.${i}` })) }]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.equal(read().code, 'invalid', JSON.stringify(bad).slice(0, 60));
    }
  });
});
