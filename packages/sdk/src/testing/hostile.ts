/**
 * What a CLI's stdout sometimes contains besides the JSON you recorded: a
 * banner, a prompt, a line cut by a crash, valid JSON of the wrong shape. The
 * peer is a third-party program, so `parseLine` and `extractSessionId` are the
 * first code of yours to meet any of it — and a throw there happens on the
 * daemon's stream reader.
 */

/** Lines that are not JSON at all. A `parseLine` must answer `[]` for each. */
export const NOT_JSON_LINES: readonly string[] = [
  '', '   ', 'Welcome to the CLI!', '{"type":', '\u0000\u0001\u0002', 'undefined', '<html>502</html>', '{"a":1}}',
];

/** Valid JSON that is not an event object, or one with fields of the wrong type. */
export const MALFORMED_JSON_LINES: readonly string[] = [
  'null', 'true', '0', '"text"', '[]', '[1,2,3]', '{}',
  '{"type":null}', '{"type":42}', '{"type":{"nested":1}}', '{"type":"result"}', '{"type":"result","is_error":"yes"}',
  '{"type":"system"}', '{"type":"system","subtype":"init"}', '{"type":"system","subtype":"init","session_id":42}',
  '{"type":"assistant","message":null}', '{"type":"assistant","message":{"content":"text"}}',
  '{"type":"assistant","message":{"content":[null,1,"x",{"type":"tool_use"}]}}',
  '{"type":"user","message":{"content":[null,1,"x",{"type":"tool_result"}]}}',
  '{"type":"item.completed"}', '{"type":"item.completed","item":null}', '{"type":"turn.completed"}', '{"type":"error"}',
  '{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}',
  '{"text":"\\ud800"}', `{"n":${'9'.repeat(400)}}`,
  `${'['.repeat(20_000)}`,
];

/** One enormous line: a tool that printed a file. Must be handled in bounded time. */
export function hugeLine(chars = 2_000_000): string {
  return `{"type":"assistant","message":{"content":[{"type":"text","text":"${'x'.repeat(chars)}"}]}}`;
}

/** Events a hostile stream (or a buggy neighbour) could hand `extractSessionId`. */
export const HOSTILE_EVENTS: ReadonlyArray<{ type: string; payload: unknown }> = [
  { type: 'system', payload: null },
  { type: 'system', payload: undefined },
  { type: 'system', payload: 'init' },
  { type: 'system', payload: [] },
  { type: 'system', payload: { subtype: 'init' } },
  { type: 'system', payload: { subtype: 'init', session_id: null } },
  { type: 'system', payload: { subtype: 'init', session_id: {} } },
  { type: 'result', payload: null },
  { type: 'assistant', payload: { subtype: 'init', session_id: 'must-not-be-read' } },
  { type: '', payload: {} },
];
