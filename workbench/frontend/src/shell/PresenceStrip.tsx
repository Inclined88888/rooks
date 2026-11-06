import { useNavigate } from "react-router-dom";
import { AssistantFace } from "../AssistantFace";
import { Presence } from "../ui";
import { usePresence } from "./presence";

/**
 * One line, 44px, above the thread: the assistant's name and mood face, what it is doing now, where, and a Needs you
 * pill that opens the inbox. It is the living part of the app and is never empty: idle reads
 * "Quiet. Watching mail and calendar." The face is the same AssistantFace the chat uses.
 */
export function PresenceStrip() {
  const p = usePresence();
  const navigate = useNavigate();
  return (
    <div className="presence-strip" data-stub={p.stub || undefined}>
      <Presence name={p.name} mood={p.mood} doing={p.doing} where={p.where} needsYou={p.needs_you} onNeedsYou={() => navigate("/jobs#needs-you")} />
    </div>
  );
}

// The face itself (kept here so the strip owns one import of it; the Presence primitive draws it).
export { AssistantFace };
