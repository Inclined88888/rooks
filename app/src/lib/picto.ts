/**
 * Pictos of plugins and widgets: one stroke style, painted as a mask.
 *
 * Copy of `orchestrator/src/plugins/bundled-icons.ts#pictoSvg` (the two
 * packages are independent, like `brand.ts`): a widget picto drawn here must
 * look like a plugin picto drawn by the daemon.
 */
export function pictoSvg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/**
 * What a `mask-image` can load from an icon a plugin hands over: SVG markup
 * becomes a `data:` URL, anything else is taken as the URL of an SVG. Never
 * injected as HTML — a mask runs no script, whoever wrote the markup.
 */
export function pictoSrc(icon: string): string {
  const trimmed = icon.trim();
  return trimmed.startsWith('<') ? `data:image/svg+xml,${encodeURIComponent(trimmed)}` : trimmed;
}
