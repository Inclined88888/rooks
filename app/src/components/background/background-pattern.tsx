'use client';

import { useId } from 'react';
import type { BackgroundPattern as Pattern } from './background-model';

/** A single SVG texture, shared by the workspace and settings previews. */
export function BackgroundPattern({ pattern, intensity = 0.3 }: { pattern: Pattern; intensity?: number }) {
  const id = `backdrop-${useId().replace(/:/g, '')}`;
  if (pattern === 'none') return null;
  const hex = pattern === 'hexagons';
  const size = hex ? [38.1, 66] : pattern === 'circuit' ? [96, 96] : [32, 32];
  return <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" style={{ color: 'hsl(var(--muted-foreground))', opacity: intensity, maskImage: 'radial-gradient(ellipse at 50% 45%, #0005 15%, #000 95%)' }}>
    <defs><pattern id={id} width={size[0]} height={size[1]} patternUnits="userSpaceOnUse">
      {hex && <g stroke="currentColor" strokeWidth="1" fill="none">
        <polygon points="19.05,-11 38.1,0 38.1,22 19.05,33 0,22 0,0" />
        <polygon points="0,22 19.05,33 19.05,55 0,66 -19.05,55 -19.05,33" />
        <polygon points="38.1,22 57.15,33 57.15,55 38.1,66 19.05,55 19.05,33" />
        <circle cx="19.05" cy="11" r="0.8" fill="currentColor" stroke="none" />
      </g>}
      {pattern === 'grid' && <path d="M32 0H0V32" fill="none" stroke="currentColor" strokeWidth="1" />}
      {pattern === 'crosses' && <path d="M12 16h8M16 12v8" fill="none" stroke="currentColor" strokeWidth="1" />}
      {pattern === 'dots' && <circle cx="16" cy="16" r="1.2" fill="currentColor" />}
      {pattern === 'circuit' && <g fill="none" stroke="currentColor" strokeWidth="1">
        <path d="M0 24h28l16 16v32h28l24 24M72 0v24L56 40v16h40" />
        <circle cx="28" cy="24" r="2.5" /><circle cx="44" cy="72" r="2.5" /><circle cx="72" cy="24" r="2.5" />
      </g>}
    </pattern>
    {hex && <pattern id={`${id}-accent`} width="266.7" height="396" patternUnits="userSpaceOnUse">
      <g fill="hsl(var(--primary))" opacity="0.2">
        <polygon points="76.2,33 95.25,44 95.25,66 76.2,77 57.15,66 57.15,44" />
        <polygon points="190.5,165 209.55,176 209.55,198 190.5,209 171.45,198 171.45,176" />
        <polygon points="38.1,231 57.15,242 57.15,264 38.1,275 19.05,264 19.05,242" />
      </g>
    </pattern>}
    </defs>
    <rect width="100%" height="100%" fill={`url(#${id})`} />
    {hex && <rect width="100%" height="100%" fill={`url(#${id}-accent)`} />}
  </svg>;
}
