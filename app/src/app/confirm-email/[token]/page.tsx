import { ConfirmEmailClient } from './confirm-email-client';

export const dynamic = 'force-dynamic';

export default function ConfirmEmailPage({ params }: { params: { token: string } }) {
  return <ConfirmEmailClient token={params.token} />;
}
