import { ProjectsRoute } from './projects-route';
import { ModulePageGate } from '@/lib/plugin-host/module-page-gate';

export const dynamic = 'force-dynamic';

export default function ProjectsPage() {
  return (
    <ModulePageGate>
      <ProjectsRoute />
    </ModulePageGate>
  );
}
