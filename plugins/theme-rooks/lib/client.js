import React from 'react'

/**
 * Carbon Tower — Rooks brand theme (dark + light).
 * Cool graphite surfaces, signal-orange accent, tight radius.
 * Distinct from any upstream violet/peach palette.
 */
const TOKENS = `
:root {
    --font-sans: "Sora", "Sora Fallback", ui-sans-serif, system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --font-display: "Sora", "Sora Fallback", ui-sans-serif, system-ui, sans-serif;

    --surface-0: 220 10% 7%;
    --surface-1: 220 9% 9.5%;
    --surface-2: 220 8% 12%;
    --surface-3: 220 8% 14.5%;
    --surface-4: 220 7% 18%;
    --surface-sunken: 220 12% 5%;
    --chrome: 220 12% 4%;
    --surface-chip: var(--surface-3);

    --shadow-1: 0 0 0 1px hsl(220 10% 100% / 0.04);
    --shadow-2: 0 0 0 1px hsl(220 10% 100% / 0.06), 0 8px 24px -12px hsl(220 20% 0% / 0.55);
    --shadow-3: 0 0 0 1px hsl(220 10% 100% / 0.08), 0 16px 40px -16px hsl(220 20% 0% / 0.65);

    --background: var(--surface-0);
    --foreground: 210 20% 96%;
    --card: var(--surface-1);
    --card-foreground: 210 20% 96%;
    --popover: var(--surface-3);
    --popover-foreground: 210 20% 96%;
    --primary: 24 95% 53%;
    --primary-foreground: 220 15% 6%;
    --secondary: var(--surface-4);
    --secondary-foreground: 210 20% 96%;
    --muted: var(--surface-2);
    --muted-foreground: 215 10% 62%;
    --accent: var(--primary);
    --accent-foreground: 220 15% 6%;
    --destructive: 0 72% 58%;
    --destructive-foreground: 0 0% 98%;
    --border: 220 8% 18%;
    --input: 220 8% 18%;
    --ring: var(--primary);
    --radius: 0.375rem;

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;

    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 16%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 36%, hsl(var(--card)));

    --rooks-scrollbar-thumb: hsl(var(--primary) / 0.28);
    --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.48);

    --hl-bg: #0b0e12;
    --avatar-radius: 0.375rem;
}

:root.light {
    --surface-0: 210 18% 97.5%;
    --surface-1: 0 0% 100%;
    --surface-2: 210 14% 94%;
    --surface-3: 0 0% 100%;
    --surface-4: 210 12% 91%;
    --surface-sunken: 210 16% 93%;
    --chrome: 210 16% 93.5%;
    --surface-chip: var(--surface-2);

    --shadow-1: 0 0 0 1px hsl(220 15% 10% / 0.06);
    --shadow-2: 0 0 0 1px hsl(220 15% 10% / 0.08), 0 8px 20px -14px hsl(220 20% 10% / 0.18);
    --shadow-3: 0 0 0 1px hsl(220 15% 10% / 0.1), 0 18px 36px -18px hsl(220 20% 10% / 0.22);

    --background: var(--surface-0);
    --foreground: 220 18% 10%;
    --card: var(--surface-1);
    --card-foreground: 220 18% 10%;
    --popover: var(--surface-3);
    --popover-foreground: 220 18% 10%;
    --primary: 24 90% 45%;
    --primary-foreground: 0 0% 100%;
    --secondary: var(--surface-4);
    --secondary-foreground: 220 18% 10%;
    --muted: var(--surface-2);
    --muted-foreground: 215 10% 40%;
    --accent: var(--primary);
    --accent-foreground: 0 0% 100%;
    --border: 210 12% 86%;
    --input: 210 12% 86%;
    --ring: var(--primary);

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;

    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 10%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 24%, hsl(var(--card)));

    --rooks-scrollbar-thumb: hsl(var(--primary) / 0.3);
    --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.5);

    --hl-bg: #e8edf3;
}
`

const ATMO = `
body {
    background-color: hsl(var(--background));
    background-image:
        linear-gradient(hsl(var(--foreground) / 0.028) 1px, transparent 1px),
        linear-gradient(90deg, hsl(var(--foreground) / 0.028) 1px, transparent 1px),
        radial-gradient(900px 480px at 0% 0%, hsl(var(--primary) / 0.07), transparent 55%),
        radial-gradient(700px 420px at 100% 100%, hsl(210 40% 40% / 0.05), transparent 50%);
    background-size: 48px 48px, 48px 48px, auto, auto;
    background-attachment: fixed;
}
:root.light body {
    background-image:
        linear-gradient(hsl(var(--foreground) / 0.035) 1px, transparent 1px),
        linear-gradient(90deg, hsl(var(--foreground) / 0.035) 1px, transparent 1px),
        radial-gradient(900px 480px at 0% 0%, hsl(var(--primary) / 0.06), transparent 55%),
        radial-gradient(700px 420px at 100% 100%, hsl(210 30% 50% / 0.04), transparent 50%);
    background-size: 48px 48px, 48px 48px, auto, auto;
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
