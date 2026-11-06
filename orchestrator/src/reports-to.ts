/**
 * Validation of an agent's `reports_to` — the single source of the agents
 * hierarchy (graph, Company chart). It also opens a messaging exemption for
 * an agent in a team (agent-messages.ts), so it is checked on write.
 */
import { canonicalAgentName, loadConfig } from './agent-config.js';
import { getAgent } from './agent.js';

/** Returns the canonical manager name, or null to fall back on the default
 *  (project lead, pole lead, main agent). Throws on an unknown agent, the
 *  agent itself, or a manager that already reports to it (a cycle). */
export function checkReportsTo(agent: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('reports_to must be an agent name or null');
  const manager = canonicalAgentName(value.trim());
  let exists = false;
  try { exists = !!getAgent(manager); } catch { exists = false; }
  if (!exists) throw new Error(`reports_to: unknown agent "${value}"`);
  const self = canonicalAgentName(agent);
  if (manager === self) throw new Error('reports_to: an agent cannot report to itself');
  const seen = new Set<string>();
  let current: string | null = manager;
  while (current && !seen.has(current)) {
    if (current === self) throw new Error(`reports_to: "${manager}" already reports to "${self}"`);
    seen.add(current);
    let next: string | null | undefined = null;
    try { next = loadConfig(current).reports_to; } catch { next = null; }
    current = next ? canonicalAgentName(next) : null;
  }
  return manager;
}
