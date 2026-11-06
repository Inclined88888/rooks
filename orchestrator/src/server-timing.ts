/**
 * `Server-Timing` header for a JSON route: where the daemon spent the time of
 * one answer, readable in the browser's network panel and by the chat's
 * `timon:chat-bind:*` measures. Only names and durations: never a value that
 * comes from the request or the data.
 */
import type { Response } from 'express';

export class ServerTiming {
  private readonly start = performance.now();
  private last = this.start;
  private readonly phases: Array<[string, number]> = [];

  /** Closes the phase running since the previous mark (or the start). */
  mark(name: string): void {
    const now = performance.now();
    this.phases.push([name, now - this.last]);
    this.last = now;
  }

  header(): string {
    const entries = [...this.phases, ['total', performance.now() - this.start] as [string, number]];
    return entries.map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`).join(', ');
  }
}

/** `res.json`, with the serialisation timed and the header set before sending. */
export function sendTimedJson(res: Response, timing: ServerTiming, body: unknown): void {
  const json = JSON.stringify(body);
  timing.mark('serialize');
  res.setHeader('Server-Timing', timing.header());
  res.type('json').send(json);
}
