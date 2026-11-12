/** Public plugin types, extracted from the host implementations (TODO #512). */
import type { SecretHint } from './browser-recordings.js';
import type { ProjectEventOrigin } from './origin.js';

// Moved from `browser-annotation-rules.ts`, which re-exports it (TODO #512, volet 3).
export interface AnnotationRect { x: number; y: number; width: number; height: number }

export type AnnotationLocator =
  | { kind: 'css'; value: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'text'; value: string }
  | { kind: 'xpath'; value: string };

export interface AnnotationTarget {
  selector: string;
  xpath: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  inputType: string;
  id: string;
  classes: string[];
  locators: AnnotationLocator[];
  flagged?: SecretHint;
}


// Moved from `browser-annotations.ts`, which re-exports it (TODO #512, volet 3).
export type BrowserAnnotationExternalRef = { provider: string; ref: string; url: string | null };

export type BrowserAnnotationMetadata = {
  id: string;
  profileId: string;
  ownerUserId: string | null;
  status: BrowserAnnotationStatus;
  createdAt: number;
  updatedAt: number;
  capturedAt: number;
  hasThumbnail: boolean;
  thumbnailBytes: number;
  sourceDetected: boolean;
  delivery: BrowserAnnotationDelivery | null;
  resolvedAt: number | null;
  resolvedBy: BrowserAnnotationOrigin | null;
  externalRef: BrowserAnnotationExternalRef | null;
};

export type BrowserAnnotationStatus = 'draft' | 'pending' | 'resolved' | 'dismissed';

export type BrowserAnnotationDelivery = {
  batchId: string;
  /** The mission it was sent to, or null when it went to an agent's next conversation. */
  missionId: string | null;
  agentName: string | null;
  sentAt: number;
};

export type BrowserAnnotationOrigin = ProjectEventOrigin;

export type BrowserAnnotationSourceView =
  | { detected: false }
  | { detected: true; framework: string; via: string; component?: string; approximate?: true;
    /** Relative to the reader's cwd and checked to exist there; null otherwise (the page's path is never repeated). */
    file: string | null; line?: number; column?: number };

export type PluginBrowserAnnotation = Readonly<Omit<BrowserAnnotationMetadata, 'ownerUserId' | 'thumbnailBytes'>>;

export type PluginBrowserAnnotationRef = BrowserAnnotationExternalRef;

/**
 * What `ownerAnnotationView` (`browser-annotations.ts`) returns for the page, the source and the
 * resolution, spelled out: that module proves at compilation that both agree (TODO #512, volet 3).
 */
type OwnerView = {
  page: {
    textWithheld: false;
    title: string;
    /** Masked like a recorded URL; '' for an internal page. */
    url: string;
    capturedAt: number;
    point: { x: number; y: number };
    target: AnnotationTarget;
    rect: AnnotationRect;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    outerHtml: string;
    outerHtmlTruncated: boolean;
  };
  source: BrowserAnnotationSourceView;
  resolution:
    | { status: 'resolved'; summary: string | null; reason?: undefined }
    | { status: 'dismissed'; reason: string | null; summary?: undefined }
    | null;
};

/** The comment is the user's; `page` and `source` were read from a web page and are untrusted. */
export type PluginBrowserAnnotationDetail = {
  annotation: PluginBrowserAnnotation;
  comment: string;
  page: OwnerView['page'];
  source: OwnerView['source'];
  resolution: OwnerView['resolution'];
};

export type PluginBrowserAnnotationResolution = { status: 'resolved'; summary: string } | { status: 'dismissed'; reason: string };

export type PluginBrowserAnnotationFilter = { profileId?: string; status?: BrowserAnnotationStatus; batchId?: string };

export type PluginBrowserAnnotationEventKind =
  | 'browser_annotation_created'
  | 'browser_annotation_updated'
  | 'browser_annotation_sent'
  | 'browser_annotation_resolved'
  | 'browser_annotation_dismissed'
  | 'browser_annotation_purged';

export type PluginBrowserAnnotationEvent = Readonly<{
  kind: PluginBrowserAnnotationEventKind;
  profileId: string;
  annotationId: string;
  /** After the write; as it was for `browser_annotation_purged`. */
  annotation: PluginBrowserAnnotation;
  /** `deleted` or `retention`, on `browser_annotation_purged`. */
  reason?: string;
  origin: ProjectEventOrigin;
}>;

export type PluginBrowserAnnotationEventMap = { [K in PluginBrowserAnnotationEventKind]: PluginBrowserAnnotationEvent & { kind: K } };

export type PluginBrowserAnnotationEventHandler = (ev: PluginBrowserAnnotationEvent) => void | Promise<void>;
