import type { Att } from "../Attachments";
import type { RouterInfo } from "../util";
import type { Card, Choices, Notice, Step } from "./events";

/** One message of the thread. `key` is the React key and never changes; `id` becomes the server's once it is known. */
export type Msg = {
  id: number; key: string; role: string; content: string; tool_calls: string[]; name: string; created_at?: string;
  via?: RouterInfo; attachments?: Att[]; choices?: Choices; cards?: Card[];
  /** The turn's step timeline (live: from the events; after a reload: rebuilt from the tool rows). */
  steps?: Step[];
  notices?: Notice[];
  /** The service's verdict on the turn (done.outcome: backed, fixed, no_claim, unbacked, ...). Only known live. */
  outcome?: string;
  /** Steps of a turn that never got a reply (stopped before answering), kept on the person's message. */
  orphanSteps?: Step[];
};

export type Conv = { id: number; title: string; channel: string; updated_at: string; model: string };
export type WorkMode = "chat" | "plan" | "build";

/** A message made in this session, before or after the server named it. */
export const madeHere = (m: Pick<Msg, "key">) => m.key.startsWith("t");
