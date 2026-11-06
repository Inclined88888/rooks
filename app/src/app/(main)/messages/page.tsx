import { MessagesClient } from './messages-client';

export const dynamic = 'force-dynamic';

export default function MessagesPage({
  searchParams,
}: {
  searchParams: { agent?: string };
}) {
  return <MessagesClient initialAgent={searchParams.agent} />;
}
