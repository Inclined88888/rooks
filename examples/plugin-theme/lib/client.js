import React from 'react'

/**
 * A theme plugin: it owns the token values, nothing else.
 *
 * `theme` is a `single` slot with a product occupant registered as
 * `fallback`. Registering here CLAIMS the slot: the fallback unmounts and
 * its `<style>` goes with it. Every token the interface reads must
 * therefore be redefined below — a partial palette leaves the missing
 * variables undefined, not inherited from the product theme.
 *
 * Two palettes, always: `:root` is the dark one, `.light` is applied by the
 * class `next-themes` puts on `<html>` when the user picks light mode.
 *
 * Runtime measures (`--timon-topbar-h`, `--timon-nav-w`,
 * `--timon-browser-w`) are NOT theme tokens: they stay in the product's
 * `globals.css`. Redefining them here would move the chrome around, which
 * is a layout plugin's job.
 */
const TOKENS = `
:root {
    --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    /* code-font: the face of code blocks, editors and terminals. */
    --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;

    /* Elevation scale (dark): one step of grey per stacking level, tinted
     * cold (h=205) instead of the product's warm grey. */
    --surface-0: 205 24% 7%;
    --surface-1: 205 22% 11%;
    --surface-2: 205 20% 15%;
    --surface-3: 205 19% 19%;
    --surface-4: 205 18% 23%;
    --surface-sunken: 205 28% 5%;
    --surface-chip: var(--surface-3);

    --shadow-1: 0 1px 2px hsl(205 40% 2% / 0.5);
    --shadow-2: 0 6px 18px -6px hsl(205 40% 2% / 0.62), 0 2px 6px -2px hsl(205 40% 2% / 0.42);
    --shadow-3: 0 18px 44px -12px hsl(205 40% 2% / 0.78), 0 6px 14px -6px hsl(205 40% 2% / 0.52);

    /* shadcn (dark) */
    --background: var(--surface-0);
    --foreground: 200 14% 92%;
    --card: var(--surface-1);
    --card-foreground: 200 14% 92%;
    --popover: var(--surface-3);
    --popover-foreground: 200 14% 92%;
    --primary: 183 62% 52%;           /* lagoon #3ec8d2 */
    --primary-foreground: 205 40% 8%;
    --secondary: var(--surface-4);
    --secondary-foreground: 200 14% 92%;
    --muted: var(--surface-2);
    --muted-foreground: 205 12% 64%;
    --accent: 258 62% 70%;            /* indigo counterpoint */
    --accent-foreground: 205 40% 8%;
    --destructive: 350 68% 66%;
    --destructive-foreground: 0 0% 98%;
    --border: 205 16% 28%;
    --input: 205 16% 28%;
    --ring: 183 62% 52%;
    --radius: 0.5rem;

    /* The product's brand ramp keeps its names: components read
     * --salmon, not "the brand colour of the day". */
    --salmon: 183 62% 52%;
    --salmon-2: 183 66% 66%;
    --salmon-3: 183 70% 80%;
    --salmon-soft: 183 62% 52% / 0.12;
    --success: 152 48% 60%;
    --warning: 40 74% 62%;
    --info: 214 68% 70%;

    --agenda-1: 183 62% 52%;
    --agenda-2: 214 68% 70%;
    --agenda-3: 152 44% 58%;
    --agenda-4: 40 70% 62%;
    --agenda-5: 258 55% 72%;
    --agenda-6: 318 44% 66%;

    --timon-grid: rgba(190, 235, 245, 0.05);

    --timon-scrollbar-thumb: hsl(183 62% 52% / 0.35);
    --timon-scrollbar-thumb-hover: hsl(183 62% 52% / 0.55);

    --hl-bg: #0b1418;
    --hl-fg: #cbd9de;
    --hl-comment: #7b8f96;
    --hl-keyword: #6fc6d6;
    --hl-string: #9fd6b0;
    --hl-number: #8fb8f0;
    --hl-function: #b79cf0;
    --hl-variable: #e0b06a;
    --hl-type: #8fb8f0;
    --hl-builtin: #7ee7c0;
    --hl-deletion-bg: #4a1220;
    --hl-addition-bg: #06392c;
}

.light {
    --surface-0: 195 30% 96%;
    --surface-1: 0 0% 100%;
    --surface-2: 195 24% 93%;
    --surface-3: 0 0% 100%;
    --surface-4: 195 20% 89%;
    --surface-sunken: 195 24% 93%;
    --surface-chip: 195 24% 93%;

    --shadow-1: 0 1px 2px hsl(205 24% 20% / 0.08);
    --shadow-2: 0 6px 18px -6px hsl(205 24% 20% / 0.14), 0 2px 6px -2px hsl(205 24% 20% / 0.08);
    --shadow-3: 0 18px 44px -12px hsl(205 24% 20% / 0.2), 0 6px 14px -6px hsl(205 24% 20% / 0.12);

    --background: var(--surface-0);
    --foreground: 205 22% 12%;
    --card: var(--surface-1);
    --card-foreground: 205 22% 12%;
    --popover: var(--surface-3);
    --popover-foreground: 205 22% 12%;
    --primary: 188 72% 32%;           /* #16788c */
    --primary-foreground: 0 0% 100%;
    --secondary: var(--surface-4);
    --secondary-foreground: 205 22% 12%;
    --muted: var(--surface-2);
    --muted-foreground: 205 12% 32%;
    --accent: 258 52% 46%;
    --accent-foreground: 0 0% 100%;
    --destructive: 352 66% 42%;
    --destructive-foreground: 0 0% 100%;
    --border: 195 20% 85%;
    --input: 195 20% 85%;
    --ring: 188 72% 32%;

    --salmon: 188 72% 32%;
    --salmon-2: 188 74% 24%;
    --salmon-3: 186 56% 74%;
    --salmon-soft: 188 72% 32% / 0.10;
    --success: 152 54% 30%;
    --warning: 34 82% 32%;
    --info: 214 62% 40%;

    --agenda-1: 188 72% 30%;
    --agenda-2: 214 62% 40%;
    --agenda-3: 152 50% 28%;
    --agenda-4: 34 76% 32%;
    --agenda-5: 258 46% 46%;
    --agenda-6: 318 40% 40%;

    --timon-grid: rgba(10, 40, 50, 0.06);

    --timon-scrollbar-thumb: hsl(188 72% 32% / 0.30);
    --timon-scrollbar-thumb-hover: hsl(188 72% 32% / 0.50);

    --hl-bg: #eef4f6;
    --hl-fg: #14202a;
    --hl-comment: #5f7480;
    --hl-string: #0a4a3a;
    --hl-keyword: #a3283c;
    --hl-number: #0b4f86;
    --hl-function: #5a35a8;
    --hl-variable: #7a4a00;
    --hl-type: #0b4f86;
    --hl-builtin: #0d5a3a;
    --hl-deletion-bg: #ffe9ec;
    --hl-addition-bg: #dcf7ec;
}
`

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  // No `fallback: true`: the product theme owns that role. Claiming the slot
  // is what makes the palette visible, and disposing restores the product's.
  return ctx.slots.register({ slot: 'theme' }, function ExampleTheme() {
    return React.createElement('style', {
      id: 'example-theme-tokens',
      dangerouslySetInnerHTML: { __html: TOKENS },
    })
  })
}
