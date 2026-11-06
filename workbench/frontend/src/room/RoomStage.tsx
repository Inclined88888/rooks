/**
 * The Room on the Stage (the right pane): the same view as the Room page inside a StageFrame, registered as the
 * "room" surface (src/stage/surfaces.tsx). A chat turn that starts the Room opens it; its own control closes it.
 */
import type { Stage } from "../shell/StageHost";
import { StageFrame } from "../ui";
import { useRoomFrame } from "./RoomView";

export function RoomStage({ stage, close }: { stage: Stage; close: () => void }) {
  const f = useRoomFrame({ mode: "stage", goal: stage.goal, onClose: close });
  return (
    <StageFrame title="The Room" label={f.label} live={f.live} captured={f.captured} controls={f.controls} className="room-frame room-stage">
      {f.body}
    </StageFrame>
  );
}

export default RoomStage;
