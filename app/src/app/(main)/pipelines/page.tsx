import { PipelinesClient } from './pipelines-client';

export const dynamic = 'force-dynamic';

export default function PipelinesPage({
  searchParams,
}: {
  searchParams: { run?: string };
}) {
  return <PipelinesClient initialRun={searchParams.run} />;
}
