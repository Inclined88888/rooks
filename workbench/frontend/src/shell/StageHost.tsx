import { useSyncExternalStore, type ReactNode } from "react";
import { BesideStage } from "../Beside";
import { Button, EmptyState, StageFrame } from "../ui";

/**
 * The Stage: the right pane that shows whatever Rooks is using right now (the Room, a browser, the terminal, your
 * desktop). It is built on the Beside split: when a surface is live the split opens with the surface on the right;
 * when nothing is live the pane shows nothing and the Beside screen picker still works as before.
 *
 * A tiny module store, so chat events, jobs and the Room page can open it from anywhere:
 *   openStage({ surface: "room", jobId, title }) / closeStage() / useStage()
 * Surfaces register how they draw themselves with registerStageSurface(surface, render); the Room and the watch
 * surfaces plug in there.
 */
export type StageSurface = "room" | "browser" | "desktop" | "terminal";
export type Stage = { surface: StageSurface; jobId?: string; title?: string; label?: string; goal?: string };
export type StageRenderer = (stage: Stage, close: () => void) => ReactNode;

const SURFACE_WORD: Record<StageSurface, string> = { room: "Room", browser: "Browser", desktop: "Desktop", terminal: "Terminal" };

let current: Stage | null = null;
const listeners = new Set<() => void>();
const renderers = new Map<StageSurface, StageRenderer>();

function notify() {
  for (const fn of listeners) fn();
}

export function openStage(stage: Stage) {
  current = { ...stage };
  notify();
}

export function closeStage() {
  if (!current) return;
  current = null;
  notify();
}

export function getStage(): Stage | null {
  return current;
}

export function subscribeStage(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useStage(): Stage | null {
  return useSyncExternalStore(subscribeStage, getStage, () => null);
}

/** How a surface draws inside the Stage. Registering again replaces the earlier renderer. */
export function registerStageSurface(surface: StageSurface, render: StageRenderer): () => void {
  renderers.set(surface, render);
  notify();
  return () => { if (renderers.get(surface) === render) renderers.delete(surface); };
}

export function stageTitle(stage: Stage): string {
  return stage.title || SURFACE_WORD[stage.surface];
}

function StagePane({ stage }: { stage: Stage }) {
  const render = renderers.get(stage.surface);
  if (render) return <>{render(stage, closeStage)}</>;
  // A surface that has not registered yet: say so plainly instead of pretending to show a screen.
  return (
    <StageFrame title={stageTitle(stage)} label={stage.label || "Nothing to show here yet."} live={false} captured={false}
      controls={<Button size="sm" onClick={closeStage}>Close</Button>}>
      <EmptyState title="Nothing on the Stage yet." line={stage.goal || `The ${SURFACE_WORD[stage.surface]} will appear here when it is live.`} />
    </StageFrame>
  );
}

/** The right pane host. Shows nothing when no surface is live; otherwise opens the split with the surface on the right. */
export function StageHost({ renderRoutes }: { renderRoutes: () => ReactNode }) {
  const stage = useStage();
  return (
    <BesideStage
      renderRoutes={renderRoutes}
      stage={stage ? { label: stageTitle(stage), node: <div className="stage-pane"><StagePane stage={stage} /></div> } : undefined}
    />
  );
}
