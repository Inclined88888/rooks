import { sseOn } from '../sse-stream';

export type ClientRealtime = {
  /** Own topics only; the server delivers signals to their owner account only. */
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
};

/** Share identity scoping and lifetime cleanup between both plugin loaders. */
export function createClientRealtime(
  id: string,
  onDispose: (dispose: () => void) => void,
  subscribeSse: typeof sseOn = sseOn,
): ClientRealtime {
  return {
    subscribe(topic, handler) {
      if (typeof topic !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(topic)) {
        throw new Error('Invalid plugin realtime topic');
      }
      const unsubscribe = subscribeSse(`plugin:${id}:${topic}`, (event) => {
        const envelope = JSON.parse(event.data) as { payload: unknown };
        handler(envelope.payload);
      });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
      };
      onDispose(dispose);
      return dispose;
    },
  };
}
