/**
 * Reading and writing one JSON value per line, the framing of every CLI codec
 * (stream-json, the JSONL of codex and copilot, JSON-RPC over stdio).
 *
 * The peer is a third-party program: a banner, a prompt, a half-written line or
 * a bare `null` are all ordinary stdout. None of them may throw into the stream
 * reader, which is why a provider's `parseLine` should start here.
 */

/** `JSON.parse` that never throws: `undefined` when the line is not JSON.
 *  (`null` is valid JSON, so it cannot stand for "not JSON".) */
export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** The line as a JSON object, or `null` for anything else: not JSON, a scalar,
 *  `null`, an array. What a codec dispatches on (`obj.type`) needs exactly this. */
export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
  const value = parseJsonLine(line);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** One value, one line, newline-terminated: what goes to the CLI's stdin. */
export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
