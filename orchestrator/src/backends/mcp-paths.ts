/** Script locations belong to the daemon installation, independently of any provider. */
import { resolve } from 'node:path';

export function mcpScriptPaths(root: string, overrides: { timon?: string; forms?: string } = {}): { timon: string; forms: string } {
  return {
    timon: overrides.timon ?? resolve(root, 'bin', 'timon-mcp.mjs'),
    forms: overrides.forms ?? resolve(root, 'bin', 'permission-mcp.mjs'),
  };
}
