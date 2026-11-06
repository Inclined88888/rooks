import {
  speechBridge, type ImportRequest, type ImportResult, type ModelListing, type ModelState, type PackResult, type SpeechBridge,
  type SpeechEvent, type SpeechState, type StartedSession,
} from './desktop-speech';
import { loadPackOffers } from './plugin-packs';

/**
 * The window's single view of the desktop's local dictation engine: its
 * state (engine availability, the default model's download), the live
 * catalog of models when the desktop lists it (TODO #484), ONE subscription
 * to the bridge's events shared by every surface, and the hook through which
 * the engine asks for the model consent card.
 *
 * One subscription because the chat composer, the cockpit's voice mode and
 * the settings pane can all be mounted at once: each filters the session
 * events by its own `sessionId`, the model events feed this store.
 */

type Listener = () => void;
type SessionListener = (event: Exclude<SpeechEvent, { type: 'model-state' }>) => void;

export class LocalEngineStore {
  private state: SpeechState | null = null;
  private listing: ModelListing[] | null = null;
  private listeners = new Set<Listener>();
  private sessionListeners = new Set<SessionListener>();
  private unsubscribe: (() => void) | null = null;
  private loading: Promise<SpeechState | null> | null = null;
  private consentPresenter: (() => void) | null = null;
  private started: StartedSession | null = null;
  private offerList: ModelListing[] = [];
  private visibleOffers: readonly ModelListing[] = [];
  private offersLoading: Promise<void> | null = null;

  constructor(
    readonly bridge: SpeechBridge,
    /** The entries the installed plugins offer (TODO #584); a fake in tests. */
    private readonly offersSource: () => Promise<ModelListing[]> = loadPackOffers,
  ) {}

  snapshot(): SpeechState | null {
    return this.state;
  }

  /** Every model of the desktop's catalog; null before the first answer, or from a desktop that cannot list. */
  models(): readonly ModelListing[] | null {
    return this.listing;
  }

  /**
   * Whether a model can dictate now: the default one, or any other the
   * desktop lists as installed (it picks among them by language). Null while
   * nothing is known yet.
   */
  hasReadyModel(): boolean | null {
    if (!this.state) return null;
    return this.state.model.status === 'ready' || (this.listing ?? []).some((entry) => entry.state.status === 'ready');
  }

  /** The entries of the plugins' packs that are not in the catalog yet. */
  offers(): readonly ModelListing[] {
    return this.visibleOffers;
  }

  /** Rereads the plugins' packs (a plugin installed or turned off since); concurrent calls share one request. */
  loadOffers(): Promise<void> {
    this.offersLoading ??= this.offersSource().catch(() => []).then((offers) => {
      this.offersLoading = null;
      this.offerList = offers;
      this.notify();
    });
    return this.offersLoading;
  }

  /**
   * Adds a plugin's entry: the desktop reads it from the daemon and asks in
   * its own box, whose button says Download, so an accepted entry starts
   * downloading at once. Null when this desktop cannot take a plugin's model.
   */
  async proposePack(pluginId: string, modelId: string): Promise<PackResult | null> {
    const result = await this.bridge.proposePack({ pluginId, modelId })
      .catch((): PackResult => ({ ok: false, code: 'unavailable', message: '' }));
    if (result?.ok) {
      await this.reloadModels();
      void this.download(result.modelId);
    }
    return result;
  }

  /** What the last dictation of this window ran on, as the desktop said it; null before one. */
  lastSession(): StartedSession | null {
    return this.started;
  }

  noteStarted(session: StartedSession): void {
    this.started = session;
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.connect();
    if (!this.state) void this.refresh();
    return () => { this.listeners.delete(listener); };
  }

  onSession(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);
    this.connect();
    return () => { this.sessionListeners.delete(listener); };
  }

  /** Rereads the state from the desktop; concurrent calls share one request. */
  refresh(): Promise<SpeechState | null> {
    this.loading ??= Promise.all([
      this.bridge.getState().catch(() => null),
      this.bridge.listModels().catch(() => null),
    ]).then(([state, listing]) => {
      this.loading = null;
      if (listing) this.listing = listing;
      if (state) this.publish(state);
      else if (listing) this.notify();
      return state;
    });
    return this.loading;
  }

  /** Rereads the catalog alone: a model joined it (an import) or left it (a deleted import). */
  async reloadModels(): Promise<void> {
    const listing = await this.bridge.listModels().catch(() => null);
    if (!listing) return;
    this.listing = listing;
    this.notify();
  }

  /** Starts or resumes a download (the desktop resumes partial files); no id: the default model. */
  async download(modelId?: string): Promise<void> {
    const model = await this.bridge.downloadModel(modelId).catch(() => null);
    if (model) this.publishModel(model);
    else await this.refresh();
  }

  /** Pause: the received bytes stay on disk for the next `download`. */
  async pause(modelId?: string): Promise<void> {
    await this.bridge.cancelDownload(modelId).catch(() => false);
    await this.refresh();
  }

  /** Cancel and delete: neither a finished model nor 600 MB of partial files stay behind. */
  async remove(modelId?: string): Promise<void> {
    await this.bridge.cancelDownload(modelId).catch(() => false);
    const model = await this.bridge.deleteModel(modelId).catch(() => null);
    if (model) this.publishModel(model);
    else await this.refresh();
    // A deleted import leaves the catalog.
    await this.reloadModels();
  }

  /** "Add a local model": the desktop opens its own folder picker. Null when this desktop cannot import. */
  async importModel(request?: ImportRequest): Promise<ImportResult | null> {
    const result = await this.bridge.importModel(request).catch((): ImportResult => ({ ok: false, code: 'io', message: '', candidates: [] }));
    if (result?.ok) await this.reloadModels();
    return result;
  }

  /** Mounted by the client half that paints the consent card. */
  presentConsentWith(presenter: () => void): () => void {
    this.consentPresenter = presenter;
    return () => { if (this.consentPresenter === presenter) this.consentPresenter = null; };
  }

  /** Opens the consent card; false when nobody paints it (its module is off). */
  requestConsent(): boolean {
    if (!this.consentPresenter) return false;
    this.consentPresenter();
    return true;
  }

  private connect(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.bridge.onEvent((event) => {
      if (event.type === 'model-state') {
        this.publishModel(event.state);
        return;
      }
      for (const listener of [...this.sessionListeners]) listener(event);
    });
  }

  private publishModel(model: ModelState): void {
    const listed = this.listing?.findIndex((entry) => entry.id === model.modelId) ?? -1;
    if (this.listing && listed >= 0) {
      this.listing = this.listing.map((entry, index) => (index === listed ? { ...entry, state: model } : entry));
    }
    if (this.state && this.state.model.modelId !== model.modelId) {
      if (listed >= 0) this.publish(this.state);
      return;
    }
    if (!this.state) {
      // A model event before the first state: the engine field is unknown, ask.
      void this.refresh();
      return;
    }
    this.publish({ ...this.state, model });
  }

  private publish(state: SpeechState): void {
    this.state = state;
    this.notify();
  }

  private notify(): void {
    const listed = new Set((this.listing ?? []).map((entry) => entry.id));
    const visible = this.offerList.filter((offer) => !listed.has(offer.id));
    if (visible.length !== this.visibleOffers.length || visible.some((offer, index) => offer !== this.visibleOffers[index])) {
      this.visibleOffers = visible;
    }
    for (const listener of [...this.listeners]) listener();
  }
}

let store: { bridge: SpeechBridge; store: LocalEngineStore } | null = null;

/** The store of this window, or null outside the desktop app. */
export function localEngine(): LocalEngineStore | null {
  const bridge = speechBridge();
  if (!bridge) return null;
  if (store?.bridge !== bridge) {
    store = { bridge, store: new LocalEngineStore(bridge) };
    // Known before the first click: a missing model then opens the consent
    // card without the microphone ever being asked for (`engine.ts`).
    void store.store.refresh();
  }
  return store.store;
}
