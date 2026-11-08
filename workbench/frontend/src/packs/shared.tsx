// Shared bits for the pack pages (feat/v02-packs).
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import "../pages/agents/agents.css";
import { ApiError, api } from "../api";
import { Button, Card, Select } from "../ui";
import { download as saveFile } from "../desktop";

export type WorkFile = { id: number; name: string; kind: string };

export async function uploadFile(file: File): Promise<WorkFile> {
  const res = await fetch(`/api/files/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST", credentials: "same-origin", headers: { "X-Workbench": "1", "Content-Type": "application/octet-stream" }, body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Could not add ${file.name}`);
  return body;
}

export function useFiles() {
  const [files, setFiles] = useState<WorkFile[]>([]);
  const reload = useCallback(() => { api<WorkFile[]>("/files").then(setFiles).catch(() => setFiles([])); }, []);
  useEffect(reload, [reload]);
  return { files, reload };
}

/** Pick a file from Files, or add one from this computer. */
export function FilePick({ value, onChange, accept, label, files, onAdded }: {
  value: number | null; onChange: (id: number | null) => void; accept?: string; label: string; files: WorkFile[]; onAdded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <div className="pk-filepick">
      <Select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{label}</option>
        {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </Select>
      <label className="ui-btn ui-btn-secondary">
        {busy ? "Adding…" : "Add from computer"}
        <input type="file" hidden accept={accept} onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true); setErr("");
          try { const up = await uploadFile(f); onAdded(); onChange(up.id); } catch (x) { setErr(String((x as Error).message)); }
          setBusy(false);
          e.target.value = "";
        }} />
      </label>
      {err && <span className="pk-err">{err}</span>}
    </div>
  );
}

/** Shown when a pack page is opened before the pack is added (409) or without Pro (402). */
export function PackGate({ error, packId, name }: { error: unknown; packId: string; name: string }) {
  const status = error instanceof ApiError ? error.status : 0;
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState("");
  if (status === 402) {
    return <Card className="pk-gate"><p className="ag-meta">Pro</p><h2 className="ag-title">{name} is part of Pro</h2>
      <p className="ag-note">{(error as Error).message}</p><div><Link className="ui-btn ui-btn-primary" to="/settings">Go to Account</Link></div></Card>;
  }
  return (
    <Card className="pk-gate">
      <p className="ag-meta">Pack</p>
      <h2 className="ag-title">Add the {name} to use this page</h2>
      <p className="ag-note">It adds a few skills and shortcuts. Each one goes through the same security check as skills from GitHub.</p>
      <div className="ag-bar">
        <Button variant="primary" busy={adding} onClick={async () => {
          setAdding(true); setMsg("");
          try { await api(`/packs/${packId}/add`, { method: "POST" }); window.location.reload(); } catch (x) { setMsg((x as Error).message); setAdding(false); }
        }}>{adding ? "Checking and adding…" : `Add ${name}`}</Button>
        <Link className="ui-btn ui-btn-ghost" to="/packs">All packs</Link>
      </div>
      {msg && <p className="pk-err">{msg}</p>}
    </Card>
  );
}

export function NotAdvice({ text }: { text: string }) {
  return <p className="pk-notice" role="note"><strong>Not legal advice.</strong> {text.replace(/^This is general information[^.]*\.\s*It is not legal advice\.\s*/i, "")}</p>;
}

export function download(url: string) {
  saveFile(url); // a download link: saved to Downloads in the Rooks app too (WebKit opens no window.open)
}

export function copy(text: string) {
  return navigator.clipboard?.writeText(text);
}
