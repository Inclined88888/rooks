/**
 * The dialects of the two published provider templates, built the way a plugin
 * builds them: from the daemon's runtime (`ctx.provider.runtime`), here the module
 * itself. Tests that need a real, coherent dialect to register import these.
 */
import type { Dialect, RemoteDialect } from '../../src/backends/types.js';
import type { ProviderRuntime } from '../../src/backends/provider-runtime.js';
import { providerRuntime } from '../../src/backends/provider-runtime.js';

const { createEchoDialect } = await import('../../../examples/plugin-provider/lib/echo-dialect.js') as {
  createEchoDialect: (runtime: ProviderRuntime) => Dialect;
};
const { createMemoryDialect } = await import('../../../examples/plugin-remote-backend/lib/memory-dialect.js') as {
  createMemoryDialect: (runtime: ProviderRuntime) => RemoteDialect;
};

export const echoDialect: Dialect = createEchoDialect(providerRuntime);
export const memoryDialect: RemoteDialect = createMemoryDialect(providerRuntime);
