import { useId } from "react";

/**
 * The Rooks mark (desktop/app-icon.svg): the chess rook as a plain tower, one rounded slab with three merlons and an
 * arched doorway lit in the one accent, safety orange (the light is on, the assistant is home), on an ink tile. The
 * colours are fixed tokens (--mark-*, tokens.css), the same in every mode. The desktop icon files still have the
 * older gold door until they are regenerated (BACKLOG.md). Decoration only: the control around it carries the words.
 */
export function RooksMark({ size = 24, className }: { size?: number; className?: string }) {
  const id = `rooks-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className={`rooks-mark${className ? ` ${className}` : ""}`} viewBox="64 64 896 896" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--mark-ink-top)" />
          <stop offset="1" stopColor="var(--mark-ink)" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="208" fill={`url(#${id})`} />
      <rect x="68" y="68" width="888" height="888" rx="204" fill="none" stroke="var(--mark-paper)" strokeOpacity=".14" strokeWidth="8" />
      <path fill="var(--mark-paper)" d="M288 248A24 24 0 0 1 312 224H379V336H467V224H557V336H645V224H712A24 24 0 0 1 736 248V760A48 48 0 0 1 688 808H336A48 48 0 0 1 288 760Z" />
      <path fill="var(--mark-door)" d="M448 808V624A64 64 0 0 1 576 624V808Z" />
    </svg>
  );
}
