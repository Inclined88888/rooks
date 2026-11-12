import { redirect } from 'next/navigation';

/**
 * `/activate` was the bare token form; the licence page swallowed it and shows
 * what is actually installed. Kept as a redirect rather than deleted: the
 * route is printed by the CLI and linked from older notes.
 */
export default function ActivatePage() {
  redirect('/license');
}
