/**
 * Hexagonal backdrop for the agents canvas, extracted to be shared between
 * the Agents page layouts (D3 constellation and project grid).
 *
 * Three stacked layers, all `pointer-events-none`: the fine grid, sparse
 * filled hexagons in primary color, and a radial halo. The radial masks
 * dampen the pattern at the center so content reads over a calm zone, with
 * the hex fully expressed at the edges.
 */
export function HexBackdrop() {
  return (
    <>
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.45] [color:hsl(var(--muted-foreground))] [mask-image:radial-gradient(ellipse_80%_70%_at_50%_45%,rgba(0,0,0,0.22)_45%,#000_95%)] dark:opacity-[0.35]"
        aria-hidden
      >
        <svg className="block h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="hex-grid-bd" width="38.1" height="66" patternUnits="userSpaceOnUse">
              <polygon
                points="19.05,-11 38.1,0 38.1,22 19.05,33 0,22 0,0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <polygon
                points="0,22 19.05,33 19.05,55 0,66 -19.05,55 -19.05,33"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <polygon
                points="38.1,22 57.15,33 57.15,55 38.1,66 19.05,55 19.05,33"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <circle cx="19.05" cy="11" r="1.0" fill="currentColor" opacity=".7" />
              <circle cx="0" cy="44" r="1.0" fill="currentColor" opacity=".7" />
              <circle cx="38.1" cy="44" r="1.0" fill="currentColor" opacity=".7" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#hex-grid-bd)" />
        </svg>
      </div>

      <div
        className="pointer-events-none fixed inset-0 opacity-[0.28] [color:hsl(var(--primary))] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_45%,rgba(0,0,0,0.2)_45%,#000_98%)]"
        aria-hidden
      >
        <svg className="block h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="hex-accent-bd" width="266.7" height="396" patternUnits="userSpaceOnUse">
              <polygon points="76.2,33 95.25,44 95.25,66 76.2,77 57.15,66 57.15,44" fill="currentColor" opacity=".45" />
              <polygon points="190.5,165 209.55,176 209.55,198 190.5,209 171.45,198 171.45,176" fill="currentColor" opacity=".38" />
              <polygon points="38.1,231 57.15,242 57.15,264 38.1,275 19.05,264 19.05,242" fill="currentColor" opacity=".32" />
              <polygon points="228.6,297 247.65,308 247.65,330 228.6,341 209.55,330 209.55,308" fill="currentColor" opacity=".42" />
              <polygon points="133.35,99 152.4,110 152.4,132 133.35,143 114.3,132 114.3,110" fill="currentColor" opacity=".28" />
              <polygon points="152.4,330 171.45,341 171.45,363 152.4,374 133.35,363 133.35,341" fill="currentColor" opacity=".30" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#hex-accent-bd)" />
        </svg>
      </div>

      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            'none',
        }}
        aria-hidden
      />
    </>
  );
}
