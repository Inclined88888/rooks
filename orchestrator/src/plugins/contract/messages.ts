

// Moved from `plugins/messages-facade.ts`, which re-exports it (TODO #512, volet 3).
export type ScopedMessages = {
  send(input: PluginMessageInput): Promise<{ id: string; createdAt: number }>;
  recv(agent: string, opts?: PluginMessageRecvOptions): Promise<PluginMessage[]>;
  /** Marks a pending message of one of the plugin's agents as read, and returns it. */
  pick(id: string): Promise<PluginMessage>;
  /** Answers a message sent to one of the plugin's agents, as that agent. */
  reply(id: string, payload: string | Record<string, unknown>): Promise<{ id: string; createdAt: number }>;
};
/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `db.ts`, which re-exports it (TODO #512, volet 3).
export type MessageKind = 'msg' | 'request' | 'response' | 'notification';

/** `held`: stopped by the agent-to-agent circuit breaker (agent-pair-breaker.ts).
 *  Out of `pending`, so no delivery path (wake, sweep, inbox pull) sees it. */
export type MessageStatus = 'pending' | 'picked' | 'expired' | 'held';

/** A message as a plugin reads it. */
export type PluginMessage = {
  id: string;
  /** The agent that wrote it, or `plugin:<id>`. */
  from: string;
  to: string;
  kind: MessageKind;
  /** The text; a JSON object travels as its JSON. */
  payload: string;
  inReplyTo: string | null;
  createdAt: number;
  pickedAt: number | null;
  status: MessageStatus;
};

export type PluginMessageInput = {
  /** The recipient agent. */
  to: string;
  payload: string | Record<string, unknown>;
  /** `request` expects an answer and needs `as`. Default `msg`. */
  kind?: 'msg' | 'request';
  /** One of the plugin's own agents to write as. Default: `plugin:<id>`. */
  as?: string;
};

export type PluginMessageRecvOptions = {
  /** Default `pending`. */
  status?: MessageStatus;
  /** Only the messages written by this agent. */
  from?: string;
  /** 1 to 200, default 50. */
  limit?: number;
};

export type PluginMessageErrorCode = 'invalid' | 'not_found' | 'forbidden';
