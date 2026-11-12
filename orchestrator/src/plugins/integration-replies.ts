/** Same turn-result contract as app channels, kept local because each ships independently. */
export type MissionReplySource = { status: string; events: { type: string; payload: unknown }[] };

export function completedReply(mission: MissionReplySource): string | undefined {
  const resultIndex = mission.events.findIndex((event) => event.type === 'result');
  const terminal = !['running', 'pending', 'waiting'].includes(mission.status);
  if (resultIndex < 0 && !terminal) return;
  const events = resultIndex < 0 ? mission.events : mission.events.slice(0, resultIndex + 1);
  const result = resultIndex < 0 ? undefined : mission.events[resultIndex]!.payload as { result?: unknown; is_error?: boolean } | null;
  if (typeof result?.result === 'string' && result.result.trim()) return result.result.trim();
  for (const event of [...events].reverse()) {
    if (event.type !== 'assistant') continue;
    const payload = event.payload as { text?: unknown; message?: { content?: unknown } } | null;
    const content = payload?.message?.content;
    const text = Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      : typeof content === 'string' ? content : typeof payload?.text === 'string' ? payload.text : '';
    if (text.trim()) return text.trim();
  }
  return result?.is_error || ['failed', 'terminated', 'cancelled'].includes(mission.status)
    ? '(mission failed or stopped — no text output)' : '(turn completed — no text output)';
}
