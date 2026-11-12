

// Moved from `plugins/layout-facade.ts`, which re-exports it (TODO #512, volet 3).
export type ScopedLayout = {
  widgets: {
    get(target?: PluginLayoutTarget): Promise<PluginLayoutSnapshot>;
    propose(input: PluginWidgetsProposalInput): Promise<PluginLayoutReceipt>;
    presetSave(input: PluginPresetInput): Promise<{ id: string; name: string; replaced: boolean }>;
  };
  islands: {
    get(target?: PluginLayoutTarget): Promise<PluginLayoutSnapshot>;
    propose(input: PluginIslandsProposalInput): Promise<PluginLayoutReceipt>;
    presetSave(input: PluginPresetInput): Promise<{ id: string; name: string; replaced: boolean }>;
  };
  nav: {
    get(): Promise<PluginLayoutSnapshot>;
    propose(input: PluginNavProposalInput): Promise<PluginLayoutReceipt>;
  };
  navigate(input: PluginNavigateInput): Promise<PluginLayoutReceipt>;
  proposals: {
    get(id: string): Promise<PluginLayoutProposal | undefined>;
    list(filter?: { missionId?: string; status?: LayoutProposalStatus; limit?: number }): Promise<PluginLayoutProposal[]>;
  };
  onboardingProfile(): Promise<{ profile: 'developer' | 'automation' | 'beginner' | null; at: number | null }>;
};

// Moved from `plugins/chat-facade.ts`, which re-exports it (TODO #512, volet 3).
export type ScopedChat = {
  showMedia(input: PluginMediaInput): Promise<PluginMediaShown>;
  proposeCommand(input: PluginCommandInput): Promise<PluginCommandReceipt>;
  commandRequests: {
    get(id: string): Promise<PluginCommandRequest | undefined>;
  };
};
/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `db.ts`, which re-exports it (TODO #512, volet 3).
export type LayoutProposalStatus = 'pending' | 'applied' | 'dismissed';

export type CommandRequestStatus = 'pending' | 'allow' | 'paste' | 'deny';

export type PluginMediaInput = {
  missionId: string;
  /** A file inside the mission's working directory, or an https address the host checks and fetches. */
  src: string;
  caption?: string;
};

export type PluginMediaShown = Readonly<{ kind: string; mime: string; source: string }>;

export type PluginCommandInput = {
  missionId: string;
  /** One line of printable text, ≤ 2000 characters. */
  command: string;
  /** ≤ 300 characters, shown on the card. */
  note?: string;
  /** The terminal session the owner pastes into; the project's by default. */
  sessionId?: string;
};

export type PluginCommandReceipt = Readonly<{ id: string; status: 'pending'; choices: readonly string[] }>;

/** A command card this plugin raised: its state and the owner's answer (`paste` = they run it, `deny` = dismissed). */
export type PluginCommandRequest = Readonly<{
  id: string;
  missionId: string;
  status: CommandRequestStatus;
  createdAt: number;
  resolvedAt: number | null;
}>;

export type PluginLayoutErrorCode =
  | 'invalid' | 'invalid_proposal' | 'no_snapshot' | 'too_large' | 'conflict'
  | 'no_owner' | 'not_found' | 'refused';

/** Where an arrangement applies: a view (`/` cockpit, `/chat`, `/agents`…) and a project slug (`null` = none). */
export type PluginLayoutTarget = { view?: string; project?: string | null };

/** What `get` returns: the owner's view of it, as the MCP tools read it (zones, catalog, tree…). */
export type PluginLayoutSnapshot = Readonly<Record<string, unknown>>;

export type PluginLayoutProposalInput = PluginLayoutTarget & {
  /** The conversation the card is shown in: one of the caller's own missions. */
  missionId: string;
  /** One line, ≤ 300 characters, shown on the card. */
  note?: string;
};

export type PluginWidgetsProposalInput = PluginLayoutProposalInput & {
  /** `{ zone: [widget ids] }` from `widgets.get().zones`. */
  zones?: Record<string, string[]>;
  remove?: string[];
  columns?: Record<string, unknown>;
};

export type PluginIslandsProposalInput = PluginLayoutProposalInput & {
  layout?: Record<string, unknown>;
  open?: Record<string, unknown>;
  widgets?: Record<string, unknown>;
};

/**
 * The side menu (`nav_propose`). At least one list: `hidden` is the complete
 * set of hidden pages; `order` the main list and `footer` the bottom of the
 * menu, paths and `'---'` separators. A list left out keeps what the menu has.
 */
export type PluginNavProposalInput = { missionId: string; hidden?: string[]; order?: string[]; footer?: string[]; note?: string };

export type PluginNavigateInput = { missionId: string; path: string; params?: Record<string, string>; note?: string };

export type PluginPresetInput = PluginLayoutTarget & { name: string; replace?: boolean };

/** What a proposal call returns: the card exists and waits for its owner. */
export type PluginLayoutReceipt = Readonly<{ id: string; status: 'pending'; warnings?: unknown[] }>;

export type PluginLayoutProposalKind = 'widgets' | 'islands' | 'nav' | 'navigate';

/** A card this plugin raised: its state and answer. */
export type PluginLayoutProposal = Readonly<{
  id: string;
  kind: string;
  missionId: string;
  status: LayoutProposalStatus;
  note: string | null;
  payload: unknown;
  createdAt: number;
  /** `null` while the owner has not decided. */
  resolvedAt: number | null;
}>;
