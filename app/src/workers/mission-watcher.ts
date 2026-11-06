/** Durable inbound and reply worker. Polling also recovers events missed during downtime. */
import { processInbox, processReply } from '../lib/channels/processor';
import { channelStore } from '../lib/channels/store';

let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

async function loop(process: () => Promise<boolean>): Promise<void> {
  while (!stopped) {
    try { if (await process()) continue; }
    catch { console.error('[channels] queue unavailable; retrying'); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  console.log('[channels] durable inbox and reply worker started');
  await Promise.all([loop(() => processInbox()), loop(() => processReply())]);
  channelStore().close();
}
main().catch(() => { console.error('[channels] worker failed'); process.exitCode = 1; });
