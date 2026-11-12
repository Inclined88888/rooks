/**
 * Launched locally by the desktop (Electron as Node) when it shows an error,
 * daemon up or not: prints `{ text, findings }` as JSON on stdout. No HTTP
 * endpoint runs it, and it never loads the database (I7).
 */
import { ROOKS_HOME } from '../paths.js';
import { reportFromEnvironment } from './diagnostic-report.js';

const at = process.argv.indexOf('--error');
const result = await reportFromEnvironment({
  source: 'desktop',
  home: ROOKS_HOME,
  appVersion: process.env.ROOKS_DESKTOP_VERSION ?? null,
  error: at >= 0 ? process.argv[at + 1]?.slice(0, 4000) : undefined,
});
process.stdout.write(JSON.stringify(result));
