/**
 * Orchestrator entry point — a single startup path.
 *
 * `node dist/index.js` remains the startup command (systemd unit, scripts,
 * Docker): it boots through the modular kernel, the only boot that has
 * existed since step 1.7. The legacy boot (`legacy-boot.ts`, a linear script
 * that registered routes and armed loops by hand) and the `TIMON_BOOT`
 * switch choosing between the two were removed after the parity campaign.
 *
 * This file stays as a named entry point rather than being replaced by
 * `boot.js`: the unit installed in production, the Dockerfile and the
 * scripts all point at `dist/index.js`, and renaming an already-deployed
 * startup target doesn't rename what invokes it.
 */
import './boot.js';
