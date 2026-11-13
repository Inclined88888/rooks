import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { settingStr } from './settings.js';

/** The one external MCP server task agents keep (`ROOKS_VAULT_MCP_SERVER`), '' when none. */
export function configuredVaultMcpServer(): string {
  return settingStr('ROOKS_VAULT_MCP_SERVER').trim();
}

/** Only an explicitly selected vault may be read; never discover a user's files. */
export function configuredVaultRoot(): string {
  const value = settingStr('ROOKS_BRAIN_VAULT').trim();
  if (!value) return '';
  const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) return '';
  try { return realpathSync(path); } catch { return ''; }
}
