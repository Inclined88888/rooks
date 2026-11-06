/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginDocHit = {
  /** `/plugins/permissions`: pass it to `read`. */
  route: string;
  title: string;
  section: string;
  score: number;
  excerpt: string;
};
