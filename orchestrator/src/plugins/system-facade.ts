/**
 * `ctx.system`: health, doctor and logs of the machine Rooks runs on.
 *
 * `health` and `doctor` answer what `GET /api/health`, `/api/health/resources`
 * and `/api/doctor` answer; `logs` what `rooks logs` prints, minus two things
 * the CLI shows to its operator: the prompts log (everything agents are told)
 * is not reachable, and every line goes through the vault redaction first.
 *
 * Who may: a job (the plugin itself) reads health and doctor; a request needs
 * a superadmin for doctor (it names binaries and paths of the machine) and for
 * logs (free text no one reviewed). `context.ts` enforces the account side;
 * the rules here are the ones it cannot know.
 */
import { z } from 'zod';
import { liveMissionCount } from '../agent.js';
import { BRAND } from '../brand.js';
import { daemonMemory } from '../daemon-memory.js';
import { diagnose } from '../doctor.js';
import { instanceId } from '../host/packaged-service.js';
import { logDir, readRecentLines } from '../log-file.js';
import { ROOKS_HOME } from '../paths.js';
import { resourceHealth } from '../resources.js';
import { redactText } from '../secrets/redact.js';
import { parseAdminInput, PluginAdminError, type AdminCallerScope } from './admin-support.js';

import type { PluginSystemHealth, PluginDoctorReport, PluginLogsOptions } from './contract/system.js';
export type {
  PluginSystemHealth, PluginDoctorReport, PluginLogKind, PluginLogsOptions,
} from './contract/system.js';

export type ScopedSystem = {
  health(): PluginSystemHealth;
  doctor(): PluginDoctorReport;
  /** The last lines, newest first, with vault values masked. */
  logs(options?: PluginLogsOptions): string[];
};

const LogsSchema = z.object({
  kind: z.enum(['daemon', 'desktop']).optional(),
  lines: z.number().int().min(1).max(1000).optional(),
}).strict();

export function systemFor(scope: AdminCallerScope): ScopedSystem {
  const needSuperadmin = (what: string): void => {
    if (!scope.job && !scope.superadmin) throw new PluginAdminError('forbidden', `${what} is for a superadmin`);
  };
  return {
    health() {
      return {
        ok: true,
        service: BRAND.id,
        instance: instanceId(ROOKS_HOME),
        liveMissions: liveMissionCount(),
        resources: resourceHealth(),
        daemon: daemonMemory(),
      };
    },
    doctor() {
      needSuperadmin('the doctor report');
      return { ...diagnose(), desktop: process.env.ROOKS_DESKTOP_EMBEDDED === '1' || process.env.ROOKS_DESKTOP_SERVICE === '1' };
    },
    logs(options = {}) {
      needSuperadmin('the logs');
      const { kind = 'daemon', lines = 100 } = parseAdminInput(LogsSchema, options);
      return readRecentLines(logDir(ROOKS_HOME), kind, lines).map(redactText);
    },
  };
}
