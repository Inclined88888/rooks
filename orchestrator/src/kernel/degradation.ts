/**
 * The warning of a module that runs without one of its `recommends` host
 * capabilities. Pure and import-free on purpose: `rooks doctor` runs from the
 * CLI and must not pull the licence runtime that `registry.ts` reads.
 */
export function degradation(
  m: { recommends?: Record<string, string> },
  capabilities: ReadonlySet<string>,
): string | null {
  const lost = Object.entries(m.recommends ?? {}).filter(([capability]) => !capabilities.has(capability));
  if (lost.length === 0) return null;
  return lost.map(([capability, effect]) => `${capability} not found on this host: ${effect}`).join('; ');
}
