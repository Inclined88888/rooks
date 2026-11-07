/**
 * The composer: the message box with attachments (button, drop, paste), the dictation orb, Send, and Stop while
 * the assistant works (the working border stays). The model and effort live in the thread header as chips.
 */
import { Square } from "lucide-react";
import { useState, type FormEvent, type RefObject } from "react";
import { AttachButton, filesFrom, PendingChips, useAttachments } from "../Attachments";
import { DictateButton } from "../voice/DictateButton";

export type ComposerProps = {
  text: string;
  onText: (text: string) => void;
  busy: boolean;
  att: ReturnType<typeof useAttachments>;
  onSend: (e?: FormEvent) => void;
  onStop: () => void;
  composerRef: RefObject<HTMLTextAreaElement>;
};

export function Composer({ text, onText, busy, att, onSend, onStop, composerRef }: ComposerProps) {
  const [dropping, setDropping] = useState(false);
  return (
    <form className="composer-wrap agents-composer-wrap" onSubmit={onSend}>
      <div className={`composer agents-composer${busy ? " is-working" : ""}${dropping ? " drop-target" : ""}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => { const f = filesFrom(e.dataTransfer); setDropping(false); if (f.length) { e.preventDefault(); att.add(f); } }}>
        <PendingChips items={att.items} onRemove={att.remove} />
        <textarea ref={composerRef} rows={1} value={text} aria-label="Message"
          onChange={(e) => { onText(e.target.value); const t = e.target; t.style.height = "auto"; t.style.height = `${Math.min(240, t.scrollHeight)}px`; }}
          placeholder="Message"
          onPaste={(e) => { const f = filesFrom(e.clipboardData); if (f.length) { e.preventDefault(); att.add(f); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }} />
        <div className="composer-bar">
          <AttachButton onFiles={att.add} disabled={busy} />
          <span className="composer-hint" aria-hidden="true">Enter to send, Shift+Enter for a new line</span>
          <div className="spacer" />
          {/* one mic: local or cloud speech to text with the browser as a fallback, drawn as the voice orb */}
          <DictateButton orb disabled={busy} onText={(t) => { onText((text ? text + " " : "") + t); composerRef.current?.focus(); }} />
          {busy
            ? <button type="button" className="btn send" onClick={onStop} aria-label="Stop" title="Stop; what was written so far is kept (Esc)"><Square size={15} /></button>
            : <button className="btn primary send" disabled={(!text.trim() && !att.ready.length) || att.uploading} aria-label="Send">Send</button>}
        </div>
      </div>
    </form>
  );
}
