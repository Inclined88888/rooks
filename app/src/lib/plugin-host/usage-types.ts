/**
 * Shape of `clientCtx.usage.list()`, mirrored from `UsageEntry` in
 * `orchestrator/src/usage.ts`.
 *
 * Duplicated rather than imported: the app and the orchestrator are two
 * independent packages (same reason `brand.ts` exists twice). The snapshot
 * test (`plugin-contract-surface.test.ts`) freezes the members, and the shape
 * itself is part of the published SDK types, which `app/sdk-guards/sdk-mirrors.ts`
 * holds these copies to.
 */
export type UsageWindow = {
  utilization: number;
  resets_at: string;
};

export type AccountUsage = {
  windows: Record<string, UsageWindow | null>;
  extra: {
    is_enabled: boolean;
    utilization: number;
    used_credits: number;
    monthly_limit: number;
    currency?: string;
    disabled_reason?: string | null;
  } | null;
};

export type UsageEntry = {
  backend: string;
  label: string;
  vendor: string;
  brand: string | null;
  /** `false` + no `error` = no probe for this profile: display nothing. */
  available: boolean;
  usage: AccountUsage | null;
  /** Present when a probe exists and failed — transient, not "no quota". */
  error?: string;
  /** `false` when a probe exists but there is no CLI session. */
  connected?: boolean;
  reason?: string;
};
