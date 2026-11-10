/** A held work change as a redline in words (design 0012): what goes out, what comes in, which cells get which values,
 * and every person a share invites, one line each and never clipped. Needs you and the chat's approval card both show
 * it; the terminal's /needs uses the same words (rooks_code/workroom.py CHANGE_WORD). */
import "./needs.css";

export type ChangeLine = { op: "remove" | "add" | "set" | "share" | string; text: string };

const CHANGE_WORD: Record<string, string> = { remove: "Takes out", add: "Puts in", set: "Sets", share: "Shares with" };

export function ChangeLines({ lines }: { lines: ChangeLine[] }) {
  return (
    <ul className="needs-change" aria-label="The change">
      {lines.map((l, i) => (
        <li key={i} className={`needs-change-${l.op}`}><span className="needs-change-word">{CHANGE_WORD[l.op] ?? "Changes"}</span> <span className="needs-change-text">{l.text}</span></li>
      ))}
    </ul>
  );
}
