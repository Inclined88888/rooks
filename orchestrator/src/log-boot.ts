/**
 * First import of `boot.ts`: everything the daemon prints from here on lands
 * in `<home>/tmp/daemon-<day>.log`, stamped (TODO #343). Only the daemon
 * imports it — the CLI and the desktop runners print to their caller.
 */
import { installProcessLog, limitsFromFiles } from './log-file.js';
import { ROOKS_HOME } from './paths.js';

installProcessLog({ home: ROOKS_HOME, kind: 'daemon', limits: () => limitsFromFiles(ROOKS_HOME) });
