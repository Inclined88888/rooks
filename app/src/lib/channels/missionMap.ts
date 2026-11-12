import { channelStore } from './store';

/** Compatibility facade; existing mappings are imported once from the legacy JSON. */
export const missionMap = {
  set(missionId: string, entry: { channel: string; replyContext: unknown }): void {
    channelStore().addReply(missionId, entry.channel, entry.replyContext);
  },
  get(missionId: string): { channel: string; replyContext: unknown } | undefined {
    const row = channelStore().getReply(missionId);
    return row ? { channel: row.channel, replyContext: JSON.parse(row.context) } : undefined;
  },
  delete(missionId: string): void { channelStore().completeReply(missionId); },
};
