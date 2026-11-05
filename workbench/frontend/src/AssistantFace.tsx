/** A small drawn assistant. Moods follow what it is doing. CSS only, so it stays light and still when motion is off. */

export type Mood = "idle" | "thinking" | "working" | "done" | "needs";

const LABEL: Record<Mood, string> = {
  idle: "here",
  thinking: "thinking",
  working: "working",
  done: "done",
  needs: "waiting for you",
};

export function AssistantFace({ mood = "idle", name = "Assistant", size = 72 }: { mood?: Mood; name?: string; size?: number }) {
  return (
    <div className={`face mood-${mood}`} style={{ width: size, height: size }} role="img" aria-label={`${name} is ${LABEL[mood]}`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle className="face-head" cx="40" cy="42" r="26" />
        <g className="face-eyes">
          <ellipse className="eye" cx="31" cy="40" rx="3.1" ry="3.5" />
          <ellipse className="eye" cx="49" cy="40" rx="3.1" ry="3.5" />
        </g>
        <path className="mouth mouth-smile" d="M32 50 Q40 57 48 50" />
        <path className="mouth mouth-flat" d="M33 51 H47" />
        <path className="mouth mouth-open" d="M33 49 Q40 54 47 49" />
        <circle className="face-hand" cx="16" cy="62" r="5" />
      </svg>
    </div>
  );
}
