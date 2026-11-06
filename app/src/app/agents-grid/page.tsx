import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The grid was merged into /agents behind a view toggle. The old URL is
 *  still served so no bookmark or existing link breaks. */
export default function AgentsGridPage() {
  redirect('/agents?view=projects');
}
