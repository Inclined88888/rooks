import { useEffect, useState } from "react";
import { api } from "./api";

type Surfaces = { computer: boolean; note: string };

/** Shown where an action needs the machine running Rooks. A paired browser elsewhere still chats. */
export function SurfaceNote() {
  const [note, setNote] = useState("");
  useEffect(() => {
    api<Surfaces>("/surfaces").then((s) => setNote(s.computer ? "" : s.note)).catch(() => undefined);
  }, []);
  if (!note) return null;
  return <div className="alert" style={{ marginBottom: 16 }}>{note}</div>;
}
