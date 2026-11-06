/**
 * The source for other agent tools in the import assistant: an occupant of
 * the `agentimport.source` socket, registered the way a third-party adapter
 * would. It lists the source, with a button that copies the `timon-export`
 * skill (from the plugin's `export-skill` route) to paste into the other tool. The
 * archive the user picks is staged as is: the engine recognises it by its
 * content (`timon-agent-import.json`, or the older `openbot-import.json`).
 */
import React from 'react';
import type { ClientContext } from '@timon-ai/sdk';
import { useAgentImport } from '../hooks.js';

type Api = ClientContext['api'];

/**
 * Puts `text` on the clipboard. The async API needs a secure context, which an
 * app reached over plain http on the network is not: the hidden-textarea path
 * covers it.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea path: a denied permission is not final there.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** `true` once the skill text is on the clipboard. */
export async function copyExportSkill(api: Api): Promise<boolean> {
  try {
    const response = await api('export-skill');
    if (!response.ok) return false;
    return await copyText(await response.text());
  } catch {
    return false;
  }
}

/** How long the button says the copy worked before it reads as a button again. */
const COPIED_MS = 2000;

export function OpenBotSource({ label, description, skillLabel, skillCopied, skillFailed, api }: {
  label: string;
  description: string;
  skillLabel: string;
  skillCopied: string;
  skillFailed: string;
  api: Api;
}): React.ReactElement | null {
  const value = useAgentImport();
  const register = value?.registerSource;
  const [failed, setFailed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const run = React.useCallback(async () => {
    const ok = await copyExportSkill(api);
    setFailed(!ok);
    setCopied(ok);
  }, [api]);
  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const actionLabel = copied ? skillCopied : skillLabel;
  React.useEffect(
    () => register?.({ id: 'openbot', label, description, accepts: ['zip'], action: { label: actionLabel, run } }),
    [register, label, description, actionLabel, run],
  );
  return failed ? <p role="alert" className="text-sm text-destructive">{skillFailed}</p> : null;
}
