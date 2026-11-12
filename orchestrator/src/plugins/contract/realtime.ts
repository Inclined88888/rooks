/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginRealtimeOptions = { ownerUserId: string };

export type PluginRealtime = {
  publish(topic: string, payload: unknown, options: PluginRealtimeOptions): void;
};
