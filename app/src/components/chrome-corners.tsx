'use client';

/**
 * The two rounded corners where the page meets the chrome.
 *
 * The topbar and the rail are one L-shaped frame, same colour and no border.
 * The page is the panel inside it, and a panel's own `border-radius` rounds it
 * on the *inside* of the corner, where the frame has nothing to show through.
 * What is wanted is the opposite: the frame's colour curving into the page. So
 * the corner is painted by the frame — a small square whose gradient is clear
 * inside a quarter circle and the frame's colour outside it, laid over the
 * page's top-left and bottom-left corners.
 *
 * It paints the colour rather than clipping the page, so it holds over any
 * wallpaper (and takes the frosted-glass fill when that is on), and it follows `--rooks-nav-w` and `--rooks-topbar-h` — pinned
 * rail, taller topbar — without a measurement of its own. Below the rail
 * (z-[15]) so the expanded rail covers it; above the page, below every dialog.
 *
 * Frosted glass from `md`: the fill is transparent and these paint nothing.
 * The island's own radius shows the chrome layer under the page, and the
 * unfolded rail carries its corners itself (`GlassRail`).
 */

const RADIUS = 16;

const corner = (at: string): React.CSSProperties => ({
  width: RADIUS,
  height: RADIUS,
  background: `radial-gradient(circle at ${at}, transparent ${RADIUS - 0.5}px, var(--rooks-chrome-fill) ${RADIUS}px)`,
});

export function ChromeCorners({ expanded = false }: {
  /** The rail is unfolded over the page (hover): its edge is no longer at
   *  `--rooks-nav-w`, so the corners follow it, at the pace of its own width
   *  transition. Pinned, the variable already says it. */
  expanded?: boolean;
}): React.ReactElement {
  const left = expanded ? 'left-56' : 'left-[var(--rooks-nav-w)]';
  return (
    <div aria-hidden className="pointer-events-none hidden md:block">
      <span
        className={`fixed top-[var(--rooks-topbar-h)] z-[14] transition-[left] duration-150 ${left}`}
        style={corner('100% 100%')}
      />
      <span
        className={`fixed bottom-0 z-[14] transition-[left] duration-150 ${left}`}
        style={corner('100% 0')}
      />
    </div>
  );
}
