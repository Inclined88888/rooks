/** Script locations belong to the daemon installation, independently of any provider. */
import { resolve } from 'node:path';

export function mcpScriptPaths(root: string, overrides: { rooks?: string; forms?: string } = {}): { rooks: string; forms: string } {
  return {
    rooks: overrides.rooks ?? resolve(root, 'bin', 'rooks-mcp.mjs'),
    forms: overrides.forms ?? resolve(root, 'bin', 'permission-mcp.mjs'),
  };
}
