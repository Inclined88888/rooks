/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginInfo = {
  id: string;
  /** Empty for a bundled module. */
  version: string;
  source: 'bundled' | 'third-party';
  /** `core` modules cannot be switched off; `null` for a third-party plugin. */
  tier: string | null;
  /** Bundled only: what the configuration asks for. */
  wanted: boolean | 'auto' | null;
  kind: string[];
  label: string | null;
  description: string | null;
  author: string | null;
  /** Third-party only: Ed25519 admission. */
  signed: boolean | null;
  /** Shipped with the product: can be disabled, never uninstalled. */
  builtin: boolean;
  /** What the daemon does with it right now. */
  state: string;
  /** Why it is not running, when it is not. */
  reason: string | null;
  route: string | null;
};
