/**
 * Where the main-agent step resumes, from the daemon's status: pure, so the
 * decision is tested without the page.
 *
 * Whether the name was given is the daemon's explicit `named`, never read from
 * the agent's name: the seat may be held by any name (`Rooks`, an orchestrator
 * found by its role), and treating every name but `_main` as "already named"
 * skipped "Your AIs" and the name for those installs.
 */
import { machineScopedStorage } from '@/lib/machines/machine-storage';

/** The open setup conversation of this tab: a reload resumes it instead of starting another. */
export const RESUME_KEY = 'rooks.setup.chat';

export type MainAgentStatus = {
  status: 'pending' | 'complete';
  available: boolean;
  name: string | null;
  /** The name step is behind (`applyMainAgentName` ran). Absent from a daemon older than the field: not named. */
  named?: boolean;
  /** The guided tour follows the step; `false` once the person chose to get to work (`setup_finish {tour}`). */
  tour?: boolean;
  /** The teammates the conversation recruited (`setup_recruit_team`). */
  team?: SetupTeammate[];
};

export type SetupTeammate = { name: string; role: 'coder' | 'reviewer' };

export type SetupEntry =
  | { kind: 'done' }
  | { kind: 'chat'; agent: string; missionId: string }
  | { kind: 'startChat'; agent: string }
  | { kind: 'providers' }
  | { kind: 'name' };

export function setupEntry(
  status: MainAgentStatus,
  resume: { agent: string; missionId: string } | null,
  providersSeen: boolean,
): SetupEntry {
  if (status.status === 'complete') return { kind: 'done' };
  if (resume && status.name === resume.agent) return { kind: 'chat', ...resume };
  if (status.named === true && status.name) return { kind: 'startChat', agent: status.name };
  return { kind: providersSeen ? 'name' : 'providers' };
}

export function readResume(): { agent: string; missionId: string } | null {
  try {
    const raw = JSON.parse(machineScopedStorage(sessionStorage).getItem(RESUME_KEY) ?? 'null') as { agent?: unknown; missionId?: unknown } | null;
    return raw && typeof raw.agent === 'string' && typeof raw.missionId === 'string'
      ? { agent: raw.agent, missionId: raw.missionId }
      : null;
  } catch { return null; }
}
