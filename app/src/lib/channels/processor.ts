import { loadChannelConfig, requireEnv } from './config';
import { spawnMission, getMission, type MissionDetails } from '../orchestrator';
import { dispatchReply } from './replyDispatcher';
import { channelStore, type ChannelStore } from './store';
import type { InboundMessage } from './types';

function channelToken(channel: string): string | undefined {
  const cfg = loadChannelConfig(channel);
  if (!cfg) throw new Error('channel unavailable');
  return cfg.api_token_env ? requireEnv(cfg.api_token_env) : undefined;
}
const spawnForChannel: typeof spawnMission = input => spawnMission({ ...input, apiToken: channelToken(input.sourceChannel!) });

export async function processInbox(store: ChannelStore = channelStore(), spawn = spawnForChannel): Promise<boolean> {
  const row = store.claimInbox();
  if (!row) return false;
  try {
    const inbound = JSON.parse(row.payload) as InboundMessage;
    const missionId = await spawn({ agent: row.agent, mission: inbound.text, sourceChannel: row.channel,
      idempotencyKey: `channel:${row.id}`, sourceMeta: { channel_receipt_id: row.id, raw: inbound.raw } });
    store.completeInbox(row, missionId);
  } catch {
    store.failInbox(row);
    console.error(`[channels] receipt ${row.id} spawn failed; retry scheduled`);
  }
  return true;
}

/** Use the first finished turn; a conversation need not exit to answer its sender. */
export function completedReply(mission: MissionDetails): string | undefined {
  const resultIndex = mission.events.findIndex(event => event.type === 'result');
  const terminal = !['running', 'pending', 'waiting'].includes(mission.status);
  if (resultIndex < 0 && !terminal) return;
  const events = resultIndex < 0 ? mission.events : mission.events.slice(0, resultIndex + 1);
  const result = resultIndex < 0 ? undefined : mission.events[resultIndex]!.payload as { result?: unknown; is_error?: boolean } | null;
  if (typeof result?.result === 'string' && result.result.trim()) return result.result.trim();
  // The last assistant message is the response, earlier messages may describe tool work.
  for (const event of [...events].reverse()) {
    if (event.type !== 'assistant') continue;
    const payload = event.payload as { text?: unknown; message?: { content?: unknown } } | null;
    const content = payload?.message?.content;
    const text = Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
      : typeof content === 'string' ? content : typeof payload?.text === 'string' ? payload.text : '';
    if (text.trim()) return text.trim();
  }
  return result?.is_error || ['failed', 'terminated', 'cancelled'].includes(mission.status)
    ? '(mission failed or stopped — no text output)' : '(turn completed — no text output)';
}

/** Poll durable mission state, including results emitted while the worker was offline. */
const getForChannel = (id: string, channel: string) => getMission(id, channelToken(channel));

export async function processReply(store: ChannelStore = channelStore(), get = getForChannel, send = dispatchReply): Promise<boolean> {
  const row = store.claimReply();
  if (!row) return false;
  try {
    let text = row.text;
    if (text === null) {
      const mission = await get(row.mission_id, row.channel);
      if (!mission) throw new Error('mission unavailable');
      const output = completedReply(mission);
      if (output === undefined) { store.deferReply(row, false); return true; }
      text = output;
      store.saveReplyText(row, text);
    }
    await send({ channelName: row.channel, replyContext: JSON.parse(row.context), text, missionId: row.mission_id,
      startPart: row.part, onPart: next => store.saveReplyPart(row, next) });
    store.completeReply(row.mission_id, row.lease);
  } catch {
    store.deferReply(row, true);
    console.error(`[channels] reply ${row.mission_id} failed; retry scheduled`);
  }
  return true;
}
