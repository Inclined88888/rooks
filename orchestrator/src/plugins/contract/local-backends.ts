/**
 * A declarative backend file (`~/.rooks/backends/<id>.json`, or an entry of a
 * pack's `backends`), as the SDK publishes it (TODO #512, volet 4). Spelled out
 * from `localBackendSchema` (`backends/local-profiles.ts`), which validates it
 * and proves at compilation that both agree: deriving it (`z.infer`) would put
 * zod, the daemon's paths and its registry in every plugin's types. What each
 * field means is documented on the schema.
 *
 * Held as a member of a carrier type rather than declared as an alias of its
 * own, and with its required fields first: `contract-surface.json` records the
 * type as the schema prints it, expanded and in that order, and an alias of an
 * object literal prints by its name.
 */
type LocalBackendShapes = {
  file: {
    id: string;
    dialect: string;
    label: string;
    defaultModel: string | null;
    models: {
      slug: string;
      label: string;
      brand?: string | undefined;
      icon?: string | undefined;
      addedAt?: number | undefined;
      hidden?: boolean | undefined;
      contextWindow?: number | undefined;
      presetLabel?: string | undefined;
      presetRank?: number | undefined;
      supportedReasoningLevels?: string[] | undefined;
      reportedReasoningLevels?: string[] | undefined;
      reasoningControl?: { type: 'budget'; min?: number | undefined; max?: number | undefined } | { type: 'toggle' } | { type: 'none' } | undefined;
    }[];
    $schema?: string | undefined;
    disabled?: boolean | undefined;
    rank?: number | undefined;
    vendor?: string | undefined;
    brand?: string | undefined;
    icon?: string | undefined;
    env?: Record<string, string | { setting: string } | { secret: string }> | undefined;
    providerConfig?: {
      id: string;
      name: string;
      baseUrl: string;
      envKey: string;
      wireApi: string;
    } | undefined;
    modelsEndpoint?: {
      url: string;
      format: 'openai';
    } | undefined;
  };
};

/** A declarative backend file, once validated. */
export type LocalBackendFile = LocalBackendShapes['file'];
