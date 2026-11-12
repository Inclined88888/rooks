import { getHeapStatistics } from 'node:v8';
import { sseGauge } from './sse.js';
import type { DaemonMemory } from './plugins/contract/system.js';
export type { DaemonMemory } from './plugins/contract/system.js';

const MB = 1024 * 1024;
const round = (bytes: number): number => Math.round((bytes / MB) * 10) / 10;

/** Heap numbers of the daemon itself, for `GET /api/health/resources`. The
 *  OOM of June 2026 was only visible once the process was dead. */
export function daemonMemory(): DaemonMemory {
  const mem = process.memoryUsage();
  return {
    heapUsedMb: round(mem.heapUsed),
    heapLimitMb: round(getHeapStatistics().heap_size_limit),
    rssMb: round(mem.rss),
    externalMb: round(mem.external),
    sse: sseGauge(),
  };
}
