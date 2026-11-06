import { CockpitBoard } from '@/components/cockpit/cockpit-board';

export const dynamic = 'force-dynamic';

/**
 * Cockpit — a board of widgets the user rearranges.
 *
 * The whole layout (rail, order, height) lives client-side in `CockpitBoard`,
 * which persists it in the local database, per user and per view. The page
 * is only a frame: the vault's 3D graph became a widget like the others, so
 * the background is free for the hexagonal grid shared with /agents and /chat.
 */
export default function CockpitPage() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <CockpitBoard />
    </div>
  );
}
