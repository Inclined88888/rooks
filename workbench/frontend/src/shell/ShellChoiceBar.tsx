/**
 * The one-time bar for Rooks opened outside the Rooks app (docs/design/0007 2.2). The launcher said which with
 * ?shell=window or ?shell=ask; the bar says the same words and offers the choice, and the answer is kept by the
 * launcher (POST /api/desktop/shell writes it to its install.json). See shellChoice.ts.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { Button } from "../ui";
import { barFor, localSeen, savedLine, SEEN_KEY, withoutShell, type ShellAnswer } from "../shellChoice";

// Read once, when the app loads: the first-run welcome may come before the shell does.
const LANDED = typeof window === "undefined" ? "" : window.location.search;

export function ShellChoiceBar() {
  const [bar] = useState(() => barFor(LANDED, localSeen));
  const [done, setDone] = useState("");
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("shell")) return;
    const { pathname, search, hash } = window.location;
    window.history.replaceState(window.history.state, "", withoutShell(pathname + search + hash));
  }, []);
  useEffect(() => { if (bar?.word === "window") localSeen.set(SEEN_KEY, "1"); }, [bar]);

  if (!bar || hidden) return null;
  const answer = async (value: ShellAnswer) => {
    try {
      await api("/desktop/shell", { method: "POST", body: { shell: value } });
      localSeen.set(SEEN_KEY, "1");
      setDone(savedLine(value));
    } catch {
      setDone(`That could not be saved here. In a terminal: ai-workspace --shell ${value}`);
    }
  };
  return (
    <div className="shell-choice" role="region" aria-label="Where Rooks opens">
      {done ? (
        <p className="shell-choice-line" role="status">{done}</p>
      ) : (
        <>
          <p className="shell-choice-line">{bar.question}</p>
          <div className="shell-choice-actions">
            {bar.choices.map((c) => (
              <Button key={c.value} size="sm" variant={c.value === "window" ? "primary" : "secondary"} onClick={() => void answer(c.value)}>{c.label}</Button>
            ))}
          </div>
        </>
      )}
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>{done ? "Close" : "Not now"}</Button>
    </div>
  );
}
