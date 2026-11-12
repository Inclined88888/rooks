/**
 * The model a backend reports on a `result` event: `model`, else `modelID`
 * (opencode), kept only when it is a non-empty string.
 *
 * Two forms of one rule: the JS one reads a stored payload, the SQL one runs
 * inside the `mission_stats` trigger (db.ts), so the mission list never parses
 * a payload. `result-model.test.ts` holds them to the same answers.
 */
export function resultModelOf(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { model?: unknown; modelID?: unknown };
    const m = parsed.model ?? parsed.modelID;
    return typeof m === 'string' && m.length > 0 ? m : null;
  } catch {
    return null;
  }
}

/** SQL twin of `resultModelOf`. `??` falls back on `modelID` only when
 *  `model` is absent or JSON null — a non-string `model` yields null, like JS. */
export function resultModelSql(payload: string): string {
  const typeOf = (path: string) => `json_type(${payload}, '${path}')`;
  return `CASE WHEN json_valid(${payload}) AND json_type(${payload}) = 'object' THEN
      CASE
        WHEN ${typeOf('$.model')} IS NOT NULL AND ${typeOf('$.model')} <> 'null' THEN
          CASE WHEN ${typeOf('$.model')} = 'text' THEN NULLIF(json_extract(${payload}, '$.model'), '') END
        WHEN ${typeOf('$.modelID')} = 'text' THEN NULLIF(json_extract(${payload}, '$.modelID'), '')
      END
    END`;
}

/** SQL: a `result` closing a turn a steer stopped (`nova_steered`, agent.ts).
 *  The conversation goes on with the steer's instruction, so it does not end
 *  the turn for whoever reads "has the agent answered?" (TODO #662). `json_valid`
 *  first: this runs inside the `mission_stats` trigger, and a payload that does
 *  not parse must not fail the insert of its event. */
export function steeredResultSql(payload: string): string {
  return `CASE WHEN json_valid(${payload}) THEN json_type(${payload}, '$.nova_steered') IS 'true' ELSE 0 END`;
}
