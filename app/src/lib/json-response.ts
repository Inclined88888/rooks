/** Reject broken transport payloads without exposing their contents in errors. */
export async function readJsonObject(response: Response, endpoint: string): Promise<Record<string, unknown>> {
  const fail = (reason: string): never => {
    const message = `[TIM-0011] ${endpoint}: ${reason} (HTTP ${response.status})`;
    console.warn(message);
    throw new Error(message);
  };
  if (!response.ok) return fail('request failed');
  const text = await response.text().catch(() => fail('response body could not be read'));
  if (!text.trim()) return fail('expected a JSON object, received an empty response');
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    if (mime && mime !== 'application/json' && !mime.endsWith('+json')) {
      return fail('expected JSON, received a non-JSON content type');
    }
    return fail(`invalid or truncated JSON (${text.length} characters)`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected a JSON object');
  return value as Record<string, unknown>;
}
