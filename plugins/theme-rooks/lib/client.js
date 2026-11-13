import React from 'react'

/**
 * Rooks moodboard theme (dark + light).
 * Warm near-black / cream paper, tower amber accent, Geist, hairline depth.
 * No teal, purple, decorative grid, or glow.
 */
const TOKENS = `
:root {
    --font-sans: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;
    /* code-font: product mono stack for code blocks, editors and terminals. */
    --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --font-display: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;

    --surface-0: 240 4% 4.5%;
    --surface-1: 240 5% 8.2%;
    --surface-2: 240 5% 10%;
    --surface-3: 240 5% 11.6%;
    --surface-4: 240 4% 15%;
    --surface-sunken: 240 5% 3%;
    --chrome: 240 4% 2.5%;
    --surface-chip: var(--surface-3);

    --shadow-1: 0 0 0 1px hsl(0 0% 100% / 0.06);
    --shadow-2: 0 0 0 1px hsl(0 0% 100% / 0.06);
    --shadow-3: 0 0 0 1px hsl(0 0% 100% / 0.08);

    --background: var(--surface-0);
    --foreground: 40 8% 92.4%;
    --card: var(--surface-1);
    --card-foreground: 40 8% 92.4%;
    --popover: var(--surface-3);
    --popover-foreground: 40 8% 92.4%;
    --primary: 31 79% 56.9%;
    --primary-foreground: 240 5% 6%;
    --secondary: var(--surface-4);
    --secondary-foreground: 40 8% 92.4%;
    --muted: var(--surface-2);
    --muted-foreground: 40 2% 52.9%;
    --accent: var(--primary);
    --accent-foreground: 240 5% 6%;
    --destructive: 0 72% 58%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 4% 16%;
    --input: 240 4% 16%;
    --ring: var(--primary);
    --radius: 0.5rem;

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;

    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 16%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 36%, hsl(var(--card)));

    --rooks-scrollbar-thumb: hsl(var(--primary) / 0.28);
    --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.48);

    --hl-bg: #0b0b0c;
    --avatar-radius: 0.375rem;
}

:root.light {
    --surface-0: 42 31% 93.7%;
    --surface-1: 34 100% 98.6%;
    --surface-2: 40 24% 91%;
    --surface-3: 34 100% 98.6%;
    --surface-4: 40 18% 88%;
    --surface-sunken: 42 22% 90%;
    --chrome: 42 24% 90%;
    --surface-chip: var(--surface-2);

    --shadow-1: 0 0 0 1px hsl(40 12% 9% / 0.08);
    --shadow-2: 0 0 0 1px hsl(40 12% 9% / 0.08);
    --shadow-3: 0 0 0 1px hsl(40 12% 9% / 0.1);

    --background: var(--surface-0);
    --foreground: 40 13% 9%;
    --card: var(--surface-1);
    --card-foreground: 40 13% 9%;
    --popover: var(--surface-3);
    --popover-foreground: 40 13% 9%;
    --primary: 29 82% 42.7%;
    --primary-foreground: 0 0% 100%;
    --secondary: var(--surface-4);
    --secondary-foreground: 40 13% 9%;
    --muted: var(--surface-2);
    --muted-foreground: 38 5% 41.4%;
    --accent: var(--primary);
    --accent-foreground: 0 0% 100%;
    --border: 40 12% 82%;
    --input: 40 12% 82%;
    --ring: var(--primary);

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;

    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 10%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 24%, hsl(var(--card)));

    --rooks-scrollbar-thumb: hsl(var(--primary) / 0.3);
    --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.5);

    --hl-bg: #efeae2;
}
`

const ATMO = `
body {
    background-color: hsl(var(--background));
}
`

function RooksTheme() {
  return React.createElement('style', {
    id: 'rooks-theme-rooks',
    dangerouslySetInnerHTML: { __html: TOKENS + ATMO },
  })
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'theme' }, RooksTheme)
}
