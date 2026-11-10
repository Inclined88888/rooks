/**
 * Needs you: one inbox for everything waiting on you, from every system (docs/design/0003-workroom.md, section 8):
 * held chat approvals, held Room calls such as a hand-off, jobs that ask before they start, and steps the desk and
 * browser helpers paused on. A side sheet opened from the presence pill, the bottom bar, the Jobs page and a held
 * hand-off in the Room; mounted once in the shell. Items come from GET /api/needs-you (asked every 5 s while open)
 * and are answered in place through POST /api/needs-you/{id}/approve or /deny, exactly once; the pill count is asked
 * again at once. The same ApprovalCard as the chat and the jobs board, with one copy: "Needs your OK".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { refreshPresence } from "../shell/presence";
import { ApprovalCard, Badge, EmptyState, Sheet, useToast } from "../ui";
import { relTime } from "../util";
import { chatLinkFor, commandFor, decidedWords, effectFor, kindWord, linkFor, type NeedsItem } from "./items";
import { closeNeedsYou, useNeedsYouOpen } from "./store";
import "./needs.css";

/** Mounted once, in the shell. */
export function NeedsYouSheet() {
  const open = useNeedsYouOpen();
  return (
    <Sheet open={open} onClose={closeNeedsYou} title="Needs you" side="right" width={460}>
      <NeedsYouList />
    </Sheet>
  );
}

export function NeedsYouList() {
  const toast = useToast();
  const [items, setItems] = useState<NeedsItem[] | null>(null);
  const [away, setAway] = useState(false);
  const [busy, setBusy] = useState("");
  // After a yes or no the card goes away: focus moves to the next card's Approve (or to the list when it is empty)
  // and the outcome is written into a status line inside the sheet, so a keyboard or screen reader user keeps their place.
  const root = useRef<HTMLDivElement>(null);
  const [said, setSaid] = useState("");
  const [focusAt, setFocusAt] = useState<number | null>(null);
  useEffect(() => {
    if (focusAt === null || items === null) return;
    const el = root.current;
    if (!el) return;
    const cards = el.querySelectorAll<HTMLElement>(".needs-item");
    const card = cards[Math.min(focusAt, cards.length - 1)];
    const target = card?.querySelector<HTMLElement>(".ui-approval-actions button") ?? el;
    target.focus();
    setFocusAt(null);
  }, [focusAt, items]);

  const load = useCallback(async () => {
    try {
      const list = await api<NeedsItem[]>("/needs-you");
      setItems(Array.isArray(list) ? list : []);
      setAway(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { setItems([]); setAway(false); }
      else setAway(true);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => window.clearInterval(t);
  }, [load]);

  const decide = async (item: NeedsItem, approve: boolean) => {
    setBusy(item.id);
    const at = Math.max(0, (items ?? []).findIndex((x) => x.id === item.id));
    try {
      const r = await api<{ status?: string; result?: string }>(`/needs-you/${encodeURIComponent(item.id)}/${approve ? "approve" : "deny"}`, { method: "POST" });
      setItems((xs) => (xs ?? []).filter((x) => x.id !== item.id));
      setFocusAt(at);
      if (r?.status === "failed") { const text = r.result || "That did not work."; setSaid(text); toast.err(new Error(text)); }
      else { const text = decidedWords(approve, r?.status, item.kind); setSaid(text); toast.ok(text); }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) {
        setSaid("That one was already answered.");
        toast.info("That one was already answered.");
        setItems((xs) => (xs ?? []).filter((x) => x.id !== item.id));
        setFocusAt(at);
      } else {
        toast.err(e);
      }
    } finally {
      setBusy("");
      void refreshPresence();
      void load();
    }
  };

  if (items === null) return <p className="needs-line" role="status">{away ? "Rooks did not answer. Trying again." : "Looking…"}</p>;
  return (
    <div ref={root} className="needs-root" tabIndex={-1}>
      <p className="sr-only" role="status">{said}</p>
      {!items.length
        ? <EmptyState className="needs-empty" title="Nothing needs you." line="Anything that waits for your OK, from chat, jobs, the Room, the browser or this computer, shows up here." />
        : (
          <div className="needs-list">
            {away && <p className="needs-line" role="status">Rooks did not answer just now; this is the last known list.</p>}
            {items.map((item) => <NeedsItemCard key={item.id} item={item} busy={busy === item.id} onDecide={(yes) => void decide(item, yes)} />)}
          </div>
        )}
    </div>
  );
}

function NeedsItemCard({ item, busy, onDecide }: { item: NeedsItem; busy: boolean; onDecide: (approve: boolean) => void }) {
  const link = linkFor(item);
  const chat = chatLinkFor(item);
  return (
    <div className="needs-item">
      <div className="needs-item-top">
        <Badge tone={item.kind === "room" ? "accent" : "neutral"}>{kindWord(item.kind)}</Badge>
        {item.since && <span className="needs-item-since">{relTime(item.since)}</span>}
        <span className="needs-space" />
        {link && <Link className="needs-link" to={link.to} onClick={closeNeedsYou}>{link.label}</Link>}
        {chat && <Link className="needs-link" to={chat.to} onClick={closeNeedsYou}>{chat.label}</Link>}
      </div>
      <ApprovalCard className="needs-card" title={item.title} detail={item.reason || item.detail || undefined} effect={effectFor(item)}
        command={commandFor(item) || undefined} busy={busy} onApprove={() => onDecide(true)} onDeny={() => onDecide(false)} />
    </div>
  );
}
