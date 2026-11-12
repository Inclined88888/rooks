/**
 * The product palette, as data — no React, no `'use client'`.
 *
 * Two consumers, one source: the `theme` slot occupant next door paints it
 * unlayered (`ui-theme.tsx`), and the app shell paints the SAME string inside
 * a cascade layer as a floor (`plugin-host/theme-floor.tsx`). Duplicating the
 * 125 tokens into `globals.css` would have been one drift away from a palette
 * that disagrees with itself.
 */
/**
 * Copied verbatim from the historical `globals.css` `:root` / `.light`
 * blocks (T.3). Infrastructure measures (`--rooks-topbar-h`, `--rooks-nav-w`,
 * `--rooks-browser-w`) stay in `globals.css`: they are runtime layout, not a
 * theme.
 */
export const THEME_TOKENS_CSS = `
:root {
    /* Product fonts live on the theme so a third-party occupant can
     * replace them. System stack: no next/font, no hosted files. */
    --font-sans: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;
    --font-display: "Geist", "Geist Fallback", ui-sans-serif, system-ui, sans-serif;
    /* code-font: the face of code blocks, editors and terminals. */
    --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

    /* Opaque neutral surfaces: canvas, panels, fields, menus, controls. */
    --surface-0: 240 4% 4.5%;
    --surface-1: 240 5% 8.2%;
    --surface-2: 240 5% 10%;
    --surface-3: 240 5% 11.6%;
    --surface-4: 240 4% 15%;
    /* Two surfaces outside the scale, for what sinks instead of rising.
     * In dark they go below the canvas, in light they rise towards
     * grey — a code block must be recessed in both cases, which a
     * single step of the scale cannot express. */
    --surface-sunken: 240 5% 3%;       /* code block, tool output */
    /* The frame (topbar + rail): no border, so it is told from the page by
     * its own colour — darker than the canvas here, greyer than it in light. */
    --chrome: 240 4% 2.5%;
    --surface-chip: var(--surface-3); /* inline code, chip */

    /* Depth is hairlines, not soft shadows. */
    --shadow-1: 0 0 0 1px hsl(0 0% 100% / 0.06);
    --shadow-2: 0 0 0 1px hsl(0 0% 100% / 0.06);
    --shadow-3: 0 0 0 1px hsl(0 0% 100% / 0.08);

    /* shadcn (dark) */
    --background: var(--surface-0);
    --foreground: 40 8% 92.4%;
    --card: var(--surface-1);
    --card-foreground: 40 8% 92.4%;
    --popover: var(--surface-3);
    --popover-foreground: 40 8% 92.4%;
    --primary: 31 79% 56.9%;            /* tower amber */
    --primary-foreground: 240 5% 6%;
    --secondary: var(--surface-4);
    --secondary-foreground: 40 8% 92.4%;
    --muted: var(--surface-2);
    --muted-foreground: 40 2% 52.9%;
    --accent: var(--primary);
    --accent-foreground: 240 5% 6%;
    --destructive: 0 64% 68%;         /* #e07a7a */
    --destructive-foreground: 0 0% 98%;
    --border: 240 4% 16%;              /* must stay above
                                          * --surface-4: otherwise borders
                                          * would vanish on secondary
                                          * buttons. */
    --input: 240 4% 16%;
    --ring: var(--primary);
    --radius: 0.375rem;

    /* ROOKS extras */
    --salmon: var(--primary);
    --salmon-2: var(--primary);           /* #f0a48f */
    --salmon-3: var(--primary);           /* #f6c7b8 */
    --salmon-soft: var(--primary) / 0.12;
    --success: 128 49% 66%;           /* #7dd28a */
    --warning: 34 67% 63%;            /* #e0b15f */
    --info: 212 62% 68%;              /* #7aa7e0 */

    /* Six-hue accent palette (charts, avatars, origin badges). The name
       is historical (the first cockpit tile that used it), and themes
       already define it. Declared as tokens rather than hard-coded in the
       components so the light theme can darken them: the same hues read
       on white turn fluorescent. */
    --agenda-1: 13 67% 63%;
    --agenda-2: 212 62% 68%;
    --agenda-3: 128 42% 62%;
    --agenda-4: 34 67% 63%;
    --agenda-5: 34 67% 63%;
    --agenda-6: 212 62% 68%;

    /* canvas dotted-grid colour, used by .rooks-canvas */
    --rooks-grid: transparent;

    /* Shape of the chat avatars — the SAME for the human and the agents.
     * A theme that wants square thumbnails sets a radius here, and both
     * sides of the conversation follow it together. These tokens are
     * outside the .light block: geometry does not depend on lightness. */
    --avatar-radius: 0.375rem;

    /* The human's bubble: OPAQUE by default. A translucent gradient let
     * the page background show through the text. The mix keeps the active
     * theme's accent hue without bringing alpha back (color-mix), and a
     * theme can redefine both tokens in one block. */
    --bubble-user: color-mix(in srgb, hsl(var(--primary)) 18%, hsl(var(--card)));
    --bubble-user-border: color-mix(in srgb, hsl(var(--primary)) 38%, hsl(var(--card)));

    /* Global scrollbar — primary hue, see .scrollbar-thin further down. */
    --rooks-scrollbar-thumb: hsl(var(--primary) / 0.32);
    --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.52);

    /* Syntax-highlighting palette (dark default). Tokens are mapped onto
     * highlight.js classes further down so the .hljs-* selectors don't
     * have to be repeated for the light theme — only the values change. */
    --hl-bg: #0d1117;
    --hl-fg: #c9d1d9;
    --hl-comment: #8b949e;
    --hl-keyword: #ff7b72;
    --hl-string: #a5d6ff;
    --hl-number: #79c0ff;
    --hl-function: #d2a8ff;
    --hl-variable: #ffa657;
    --hl-type: #79c0ff;
    --hl-builtin: #7ee787;
    --hl-deletion-bg: #67060c;
    --hl-addition-bg: #033a16;
}

:root.light {
    /* Light mode: cream paper canvas and warm near-black ink. */
    --surface-0: 42 31% 93.7%;
    --surface-1: 34 100% 98.6%;
    --surface-2: 40 24% 91%;
    --surface-3: 34 100% 98.6%;
    --surface-4: 40 18% 88%;
    --surface-sunken: 42 22% 90%;
    --chrome: 42 24% 90%;
    --surface-chip: 40 24% 91%;

    --shadow-1: 0 0 0 1px hsl(40 12% 9% / 0.08);
    --shadow-2: 0 0 0 1px hsl(40 12% 9% / 0.08);
    --shadow-3: 0 0 0 1px hsl(40 12% 9% / 0.1);

    --background: var(--surface-0);
    --foreground: 40 13% 9%;
    --card: var(--surface-1);
    --card-foreground: 40 13% 9%;
    --popover: var(--surface-3);
    --popover-foreground: 40 13% 9%;
    --primary: 29 82% 42.7%;            /* tower amber */
    --primary-foreground: 0 0% 100%;
    --secondary: var(--surface-4);
    --secondary-foreground: 40 13% 9%;
    --muted: var(--surface-2);
    --muted-foreground: 38 5% 41.4%;
    --accent: var(--primary);
    --accent-foreground: 0 0% 100%;
    --destructive: 4 62% 45%;         /* #b8362c */
    --destructive-foreground: 0 0% 100%;
    --border: 40 12% 82%;
    --input: 40 12% 82%;
    --ring: var(--primary);

    --salmon: var(--primary);
    --salmon-2: var(--primary);
    --salmon-3: var(--primary);
    --salmon-soft: var(--primary) / 0.12;
    --success: 144 50% 36%;           /* #2e8a52 */
    --warning: 39 100% 32%;           /* #a36a00 */
    --info: 212 60% 41%;              /* #2864a8 */

    --agenda-1: 11 58% 48%;
    --agenda-2: 212 60% 41%;
    --agenda-3: 144 50% 30%;
    --agenda-4: 32 78% 34%;
    --agenda-5: 32 78% 34%;
    --agenda-6: 212 60% 41%;

    --rooks-grid: transparent;

    --rooks-scrollbar-thumb: hsl(var(--primary) / 0.32);
    --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.52);

    /* GitHub-light flavoured syntax palette — high enough contrast on
     * the soft cream chat-bubble background, no eye-strain. */
    --hl-bg: #f2f4f7;
    --hl-fg: #1f2328;
    --hl-comment: #6e7781;
    --hl-keyword: #cf222e;
    --hl-string: #1a7f37;
    --hl-number: #0550ae;
    --hl-function: #8250df;
    --hl-variable: #953800;
    --hl-type: #0550ae;
    --hl-builtin: #116329;
    --hl-deletion-bg: #ffebe9;
    --hl-addition-bg: #dafbe1;
}
`;
