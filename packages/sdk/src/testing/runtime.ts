/**
 * The runtime of a provider, for tests run outside the daemon: a COPY of what
 * `ctx.provider.runtime` hands a plugin inside it. The conformance bench uses it
 * to drive a dialect the way the daemon does, and the stand-in `ctx`
 * (`createProviderContext`) puts it where a plugin looks for it.
 */
import { setBackendHomeDirsFallback } from '../../../../orchestrator/src/backends/credential-home-dirs.js';
import { PRODUCT_BACKEND_HOME_DIRS } from '../product-credential-dirs.js';

export { providerRuntime } from '../../../../orchestrator/src/backends/provider-runtime.js';

// The package ships no manifest of the official providers: without their sign-in folders,
// `check.declarationProblems` would accept `.claude` and the daemon refuse it at registration.
setBackendHomeDirsFallback(PRODUCT_BACKEND_HOME_DIRS);
