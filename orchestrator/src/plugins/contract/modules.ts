/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginModuleInfo = {
  id: string;
  /** `core` modules cannot be switched off. */
  tier: string;
  /** What the daemon does right now, licence and host capabilities included. */
  active: boolean;
  /** Why it is not active, when it is not. */
  reason: string | null;
  /** Host capabilities it needs and the machine lacks. */
  missing: string[];
  /** What the configuration asks for. */
  wanted: boolean | 'auto';
};
