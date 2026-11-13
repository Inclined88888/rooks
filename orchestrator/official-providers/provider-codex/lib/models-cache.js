/**
 * The model list and reasoning levels the Codex CLI caches for THIS account,
 * read from the file it keeps beside its login
 * (`<CODEX_HOME>/models_cache.json`, `~/.codex` by default).
 *
 * The models written in `profiles.ts` are true on the day of the commit; the
 * CLI refreshes its cache from the account and knows when new models are added
 * or removed. So the cache is the authoritative source for which models the
 * account can access, and the frozen list is the fallback when it is absent.
 *
 * A file owned by another program, read on every catalogue read:
 *   - the schema is loose — codex adds keys between versions, and a strict
 *     parse would reject the cache at the next CLI update;
 *   - absent, unreadable or invalid means no cache, never an error;
 *   - the parse is kept until the file's mtime changes.
 *
 * Under the test runner, only an explicit `CODEX_HOME` is read: otherwise every
 * catalogue test would see the developer's own account (same guard as
 * `paths.ts` for `ROOKS_HOME`).
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Level names end up as a CLI argument (`-c model_reasoning_effort=…`). */
const LEVEL_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * What the cache must look like to be read at all: the schema the core validated with a library the
 * plugin does not carry. Loose on purpose — keys it does not know are ignored — and strict on what
 * becomes a slug or a CLI argument: one entry that does not fit and the whole cache is unusable
 * (the profile's own list serves), as before.
 */
function parseCache(value) {
    if (!isRecord(value) || !Array.isArray(value.models) || value.models.length > 500)
        return null;
    const models = [];
    for (const model of value.models) {
        if (!isRecord(model) || typeof model.slug !== 'string' || model.slug.length < 1 || model.slug.length > 200)
            return null;
        if (model.visibility !== undefined && typeof model.visibility !== 'string')
            return null;
        let levels;
        if (model.supported_reasoning_levels !== undefined) {
            const raw = model.supported_reasoning_levels;
            if (!Array.isArray(raw) || raw.length > 12)
                return null;
            levels = [];
            for (const level of raw) {
                if (!isRecord(level) || typeof level.effort !== 'string' || !LEVEL_NAME.test(level.effort))
                    return null;
                levels.push(level.effort);
            }
        }
        models.push({ slug: model.slug, visibility: model.visibility, levels });
    }
    return models;
}
/** Where the CLI keeps its cache, or null when nothing should be read. */
export function codexModelsCachePath() {
    const fromEnv = process.env['CODEX_HOME'];
    if (fromEnv)
        return join(fromEnv, 'models_cache.json');
    if (process.env['NODE_TEST_CONTEXT'])
        return null;
    return join(homedir(), '.codex', 'models_cache.json');
}
let memo = null;
function readCache() {
    const path = codexModelsCachePath();
    if (!path)
        return { levels: null, slugs: null };
    let mtimeMs;
    let size;
    try {
        ({ mtimeMs, size } = statSync(path));
    }
    catch {
        return { levels: null, slugs: null };
    }
    if (memo && memo.path === path && memo.mtimeMs === mtimeMs && memo.size === size) {
        return { levels: memo.levels, slugs: memo.slugs };
    }
    let levels = null;
    let slugs = null;
    try {
        const parsed = parseCache(JSON.parse(readFileSync(path, 'utf8')));
        if (parsed) {
            levels = new Map();
            slugs = [];
            for (const model of parsed) {
                if (model.visibility === 'list')
                    slugs.push(model.slug);
                const efforts = [...new Set(model.levels ?? [])];
                if (efforts.length)
                    levels.set(model.slug, efforts);
            }
        }
    }
    catch {
        // Unreadable or not JSON: the frozen list serves, as with no cache at all.
    }
    memo = { path, mtimeMs, size, levels, slugs };
    return { levels, slugs };
}
/**
 * Levels per model slug, as the account's cache lists them. Null when there is
 * no usable cache. A model listed without levels is absent from the map: it
 * keeps whatever the profile says.
 */
export function codexAccountLevels() {
    return readCache().levels;
}
/**
 * Slugs the account's cache lists with `visibility: 'list'`. Null when there
 * is no usable cache; an empty array means the cache was valid but listed no
 * visible model. The frozen profile list is the fallback when this returns null.
 */
export function codexAccountSlugs() {
    return readCache().slugs;
}
