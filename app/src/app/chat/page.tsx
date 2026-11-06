import { ChatRoute } from './chat-route';
import { ModulePageGate } from '@/lib/plugin-host/module-page-gate';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    <ModulePageGate>
      <ChatRoute />
    </ModulePageGate>
  );
}
