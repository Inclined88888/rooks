/**
 * A new chat: the greeting line (Bodoni, by the time of day), one sentence, three things to do built from the
 * person's own routines and the automation examples, and how many things need them right now.
 */
import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { usePresence } from "../shell/presence";
import { Chip } from "../ui";
import { greeting, suggestionChips, type Routine, type Suggestion } from "./turns";

export function EmptyChat({ who, line, onSend, disabled }: { who: string; line?: string; onSend: (text: string) => void; disabled?: boolean }) {
  const [chips, setChips] = useState<Suggestion[]>(() => suggestionChips([]));
  const presence = usePresence();
  useEffect(() => {
    let stop = false;
    api<{ routines: Routine[] }>("/assistant/routines")
      .then((r) => { if (!stop) setChips(suggestionChips(r.routines || [])); })
      .catch(() => undefined);
    return () => { stop = true; };
  }, []);
  const needs = presence.needs_you;
  return (
    <div className="chat-empty">
      <p className="chat-empty-title">{greeting(new Date().getHours())}</p>
      <p className="chat-empty-line" role={line ? "status" : undefined}>{line || `${who} is here. Ask for anything, or start with one of these.`}</p>
      <div className="chat-empty-chips" role="group" aria-label="Things to do">
        {chips.map((c) => (
          <span key={c.text} className="chat-empty-chip">
            <Chip onClick={disabled ? undefined : () => onSend(c.send)} title={c.send}>{c.text}</Chip>
          </span>
        ))}
      </div>
      {needs > 0 && (
        <Link className="chat-empty-needs" to="/jobs#needs-you">
          <AlertTriangle size={13} aria-hidden="true" /> {needs === 1 ? "One thing needs you" : `${needs} things need you`}
        </Link>
      )}
    </div>
  );
}
