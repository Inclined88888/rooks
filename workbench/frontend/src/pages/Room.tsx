import { Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, EmptyState } from "../ui";

type RoomStatus = { available?: boolean; running?: boolean; screen?: boolean; pointer?: boolean; label?: string; note?: string };

/**
 * The Room: Rooks' own computer inside the app. This is the placeholder for the Room page; the live view, Step in,
 * Hand back, Save a point and Start over arrive with the Room stage. It reads the Room's status when the service has
 * it and says plainly when it does not.
 */
export default function RoomPage() {
  const [line, setLine] = useState("Checking this computer…");
  useEffect(() => {
    let stop = false;
    api<RoomStatus>("/room/status")
      .then((s) => { if (!stop) setLine(s.label || (s.available ? "Ready on this computer." : "Not on this computer yet.")); })
      .catch(() => { if (!stop) setLine("Not on this computer yet."); });
    return () => { stop = true; };
  }, []);
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <Card>
        <EmptyState
          icon={<Laptop size={28} />}
          title="The Room is on its way."
          line={`Rooks gets its own computer inside this app. You will watch it work, step in, hand it back and undo what it did. ${line}`}
        />
      </Card>
    </div>
  );
}
