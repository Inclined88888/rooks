/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginBrowserSession = {
  /** The project slug: one browser per project. */
  project: string;
  status: string;
  /** Remote-desktop address, `null` when no host is configured. */
  url: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  lastUsedAt: number | null;
  /** Started by the caller's account (or by this plugin, in a job). */
  mine: boolean;
};
