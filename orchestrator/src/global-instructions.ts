/**
 * The user's global instructions: one markdown file, sent to EVERY agent of the
 * install at each spawn, right after the Rooks preamble and the backend block.
 *
 * It holds what belongs to the person and not to Rooks — their language, how
 * they want commits written, how they test, when they let agents work at night.
 * The Rooks preamble stays about Rooks only; a project's own rules live in its
 * AGENTS.md, an agent's in its identity docs.
 *
 * A plain file rather than a setting or a memory rule: a setting is one line, a
 * memory rule is only recalled when it matches (or is `core`) and belongs to a
 * module that can be switched off. This must always reach the agent.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GLOBAL_INSTRUCTIONS_FILE } from './paths.js';

/** Characters accepted and sent: a note pasted whole must not swallow the context of every mission. */
export const GLOBAL_INSTRUCTIONS_MAX_CHARS = 32_000;

/** The file as written, or '' when there is none. */
export function readGlobalInstructions(): string {
  try {
    return existsSync(GLOBAL_INSTRUCTIONS_FILE) ? readFileSync(GLOBAL_INSTRUCTIONS_FILE, 'utf8') : '';
  } catch { return ''; }
}

/** What reaches the prompt: trimmed, and cut at the cap (a file edited by hand can exceed it). */
export function loadGlobalInstructions(): { content: string; truncated: boolean } {
  const text = readGlobalInstructions().trim();
  const truncated = text.length > GLOBAL_INSTRUCTIONS_MAX_CHARS;
  return { content: truncated ? text.slice(0, GLOBAL_INSTRUCTIONS_MAX_CHARS) : text, truncated };
}

/** Writes the file; throws when the text is over the cap. */
export function writeGlobalInstructions(text: string): void {
  if (text.length > GLOBAL_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(`global instructions are limited to ${GLOBAL_INSTRUCTIONS_MAX_CHARS} characters (got ${text.length})`);
  }
  writeFileSync(GLOBAL_INSTRUCTIONS_FILE, text);
}
