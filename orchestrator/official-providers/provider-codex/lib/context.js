/**
 * Context-window snapshot of a codex mission, read from its rollout.
 *
 * `codex exec --json` only reports usage on `turn.completed`, and that usage
 * is SUMMED over every model call of the turn (millions of tokens on a long
 * tool loop): it cannot say how full the context is. The rollout the CLI
 * writes in the mission's CODEX_HOME can — each `token_count` event carries
 * `last_token_usage` (the latest call alone) and `model_context_window`.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** A rollout grows to megabytes; the last events are all we need. */
const TAIL_BYTES = 512 * 1024;
function newestRollout(sessionsDir) {
    let best = null;
    let entries;
    try {
        entries = readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' });
    }
    catch {
        return null;
    }
    for (const rel of entries) {
        if (!/rollout-[^/\\]*\.jsonl$/.test(rel))
            continue;
        const path = join(sessionsDir, rel);
        try {
            const mtime = statSync(path).mtimeMs;
            if (!best || mtime > best.mtime)
                best = { path, mtime };
        }
        catch { /* vanished */ }
    }
    return best?.path ?? null;
}
function readTail(path) {
    const fd = openSync(path, 'r');
    try {
        const size = statSync(path).size;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8');
    }
    finally {
        closeSync(fd);
    }
}
/** Parses the tail of a rollout. Exported for the test. */
export function snapshotFromRolloutTail(tail) {
    const lines = tail.split('\n');
    let snap = null;
    // Backwards: the latest token_count wins, then the latest turn_context
    // names the model it was measured on.
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i] ?? '';
        const isCount = line.includes('"token_count"');
        const isTurn = snap && line.includes('"turn_context"');
        if (!isCount && !isTurn)
            continue;
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        } // first line of the tail is cut
        if (!snap && row.payload?.type === 'token_count') {
            const tokens = row.payload.info?.last_token_usage?.input_tokens;
            if (typeof tokens !== 'number' || tokens <= 0)
                continue;
            const window = row.payload.info?.model_context_window;
            snap = { tokens, window: typeof window === 'number' && window > 0 ? window : null, model: null };
        }
        else if (snap && row.type === 'turn_context') {
            if (typeof row.payload?.model === 'string' && row.payload.model)
                snap.model = row.payload.model;
            break;
        }
    }
    return snap;
}
export function codexContextSnapshot(codexHome) {
    try {
        const rollout = newestRollout(join(codexHome, 'sessions'));
        return rollout ? snapshotFromRolloutTail(readTail(rollout)) : null;
    }
    catch {
        return null;
    }
}
