/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `plugins-bundled/ui-documents/model.ts`, which re-exports it (TODO #512, volet 3).
/** The document without its HTML. `reply` is present only for whoever may read it (D6, D8). */
export type UiDocumentView = {
  id: string;
  missionId: string;
  title: string;
  /** Who created the document. */
  origin: { kind: UiDocumentOriginKind; id: string | null };
  bridge: UiDocumentBridge;
  height: number | null;
  expectsReply: boolean;
  status: UiDocumentStatus;
  resolvedBy: UiDocumentActor | null;
  resolvedAt: number | null;
  project: string | null;
  missionTitle: string;
  taskId: string | null;
  createdAt: number;
  /** The creator plugin's external reference; shown to the session and to that plugin only. */
  ref?: { provider: string; ref: string };
  reply?: unknown;
};

export type UiDocumentActor = { kind: string; id: string | null };

// Moved from `db.ts`, which re-exports it (TODO #512, volet 3).
export type UiDocumentStatus = 'shown' | 'pending' | 'answered' | 'dismissed';

export type UiDocumentOriginKind = 'agent' | 'user' | 'plugin';

export type UiDocumentBridge = 'timon' | 'raw';

/** A document as any plugin reading it sees it: no HTML, no reply. */
export type PluginUiDocument = Readonly<Omit<UiDocumentView, 'reply'>>;

/** A document this plugin created: its reply too (`null` until answered). */
export type PluginOwnUiDocument = PluginUiDocument & Readonly<{ reply: unknown }>;

export type PluginUiDocumentInput = {
  missionId: string;
  /** One line, ≤ 120 characters, shown as text. */
  title: string;
  /** The whole document, ≤ 512 KiB of UTF-8. */
  html: string;
  /** Initial height in pixels, 80–2000. */
  height?: number;
  /** The card waits for the owner's answer; it comes back as `ui_document_resolved` (this plugin's own, with its `reply`). */
  expectsReply?: boolean;
  /** `timon` (default) injects the MCP Apps bootstrap; `raw` serves the document as is, for an app with its own SDK. */
  bridge?: 'timon' | 'raw';
  /** External reference, unique per plugin (`findByRef`). */
  ref?: { provider: string; ref: string };
};

export type PluginUiDocumentErrorCode =
  | 'invalid' | 'not_found' | 'no_owner' | 'document_too_large' | 'too_many_documents' | 'ref_taken'
  | 'reply_not_yet_supported' | 'module_disabled';

export type PluginUiDocumentEventKind = 'ui_document_created' | 'ui_document_resolved';

/** Who: `agent` (name), `user` (account id), `plugin` (plugin id). */
export type PluginUiDocumentActor = Readonly<{ kind: string; id: string | null }>;

export type PluginUiDocumentCreatedEvent = Readonly<{
  kind: 'ui_document_created';
  documentId: string;
  document: PluginUiDocument | PluginOwnUiDocument;
  creator: PluginUiDocumentActor;
  /** Who caused the event: the creator. */
  origin: PluginUiDocumentActor;
}>;

export type PluginUiDocumentResolvedEvent = Readonly<{
  kind: 'ui_document_resolved';
  documentId: string;
  /** `answered` or `dismissed`. */
  status: 'answered' | 'dismissed';
  document: PluginUiDocument | PluginOwnUiDocument;
  creator: PluginUiDocumentActor;
  /** Who caused the event: the user who answered, the agent or plugin that removed it. */
  origin: PluginUiDocumentActor;
}>;

export type PluginUiDocumentEvent = PluginUiDocumentCreatedEvent | PluginUiDocumentResolvedEvent;

export type PluginUiDocumentEventMap = {
  ui_document_created: PluginUiDocumentCreatedEvent;
  ui_document_resolved: PluginUiDocumentResolvedEvent;
};

export type PluginUiDocumentEventHandler = (ev: PluginUiDocumentEvent) => void | Promise<void>;
