import { useEffect, useState } from "react";

/** A small drawn companion. Moods follow what it is doing. CSS only, so it stays light and still when motion is off. */

export type Mood = "idle" | "thinking" | "working" | "done" | "needs";

const LABEL: Record<Mood, string> = {
  idle: "here",
  thinking: "thinking",
  working: "working",
  done: "done",
  needs: "waiting for you",
};

/** True when this message names the assistant or thanks it. Used for one gentle reaction, not a new mood. */
export function noticedYou(text: string, name: string): boolean {
  const said = text.trim().toLowerCase();
  if (!said) return false;
  if (/\b(thanks|thank you|cheers)\b/.test(said)) return true;
  const called = name.trim().toLowerCase();
  if (called.length < 2) return false;
  const safe = called.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${safe}\\b`).test(said);
}

export function AssistantFace({
  mood = "idle", name = "Assistant", size = 72, pleasedAt = 0,
}: { mood?: Mood; name?: string; size?: number; pleasedAt?: number }) {
  const [burst, setBurst] = useState(false);
  useEffect(() => {
    if (!pleasedAt) return;
    setBurst(true);
    const t = window.setTimeout(() => setBurst(false), 1400);
    return () => window.clearTimeout(t);
  }, [pleasedAt]);
  const pleased = burst ? " is-pleased" : "";
  return (
    <div className={`face mood-${mood}${pleased}`} style={{ width: size, height: size }} role="img" aria-label={`${name} is ${burst ? "pleased" : LABEL[mood]}`}>
      <svg viewBox="0 0 88 80" aria-hidden="true">
        <path className="face-body" d="M44 10c18 0 32 14 32 32 0 16-13 28-32 28S12 58 12 42C12 24 26 10 44 10z" />
        <ellipse className="blush" cx="22" cy="50" rx="6" ry="3.4" />
        <ellipse className="blush" cx="66" cy="50" rx="6" ry="3.4" />
        <g className="eyes-open">
          <g className="look">
            <g className="eye" transform="translate(30 38)">
              <ellipse className="eye-white" cx="0" cy="0" rx="8" ry="9" />
              <circle className="pupil" cx="0.4" cy="1.2" r="3.3" />
              <circle className="eye-shine" cx="-1.3" cy="-1.5" r="1.15" />
            </g>
            <g className="eye" transform="translate(58 38)">
              <ellipse className="eye-white" cx="0" cy="0" rx="8" ry="9" />
              <circle className="pupil" cx="0.4" cy="1.2" r="3.3" />
              <circle className="eye-shine" cx="-1.3" cy="-1.5" r="1.15" />
            </g>
          </g>
        </g>
        <g className="eyes-happy">
          <path d="M23 40q7-9 14 0" />
          <path d="M51 40q7-9 14 0" />
        </g>
        <path className="mouth mouth-soft" d="M34 56q10 9 20 0" />
        <path className="mouth mouth-small" d="M38 57h12" />
        <ellipse className="mouth mouth-oh" cx="44" cy="57" rx="3.6" ry="2.8" />
      </svg>
    </div>
  );
}
