'use client';

import { useSearchParams } from 'next/navigation';
import { AgentEditor } from '@/components/agent-editor/agent-editor';

/** Full-page host for the editor. Everywhere else it opens as an overlay
 *  (`openAgentEditor`); this route keeps deep links working. */
export function EditClient() {
  const params = useSearchParams();
  return <AgentEditor agent={params.get('agent')} isNew={params.get('new') === '1'} />;
}
