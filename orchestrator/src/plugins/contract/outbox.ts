/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginOutboxMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Where the call goes: a URL, or the NAME of a granted vault entry holding it. */
export type PluginOutboxTarget = string | { secret: string };

export type PluginOutboxOptions = {
  /** Calls sharing a key leave in order (e.g. `todo:42`: outcome, then closure). */
  key?: string;
  method?: PluginOutboxMethod;
  /** Non-secret headers. Credentials go through `auth`, never here. */
  headers?: Record<string, string>;
  /** Standard Webhooks signature with this granted vault entry (`whsec_…` or raw). */
  sign?: { secret: string };
  /** A header built from a granted vault entry: `Authorization: Bearer <value>` by default;
   *  `scheme: ''` sends the value alone (`X-Api-Key: <value>`, the default off `Authorization`). */
  auth?: { secret: string; header?: string; scheme?: string };
};

export type PluginOutboxEntry = {
  id: string;
  key: string | null;
  state: 'pending' | 'delivered' | 'failed';
  attempts: number;
  /** `HTTP <status>` or an error name; never a response body. */
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  failed_at: number | null;
};

export type PluginOutboxErrorCode = 'invalid' | 'not_allowed' | 'secret_missing' | 'full';
