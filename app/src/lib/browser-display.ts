/** CSS-pixel viewport: devicePixelRatio changes sharpness, not the site layout. */
export const DESKTOP_RES = { width: 1366, height: 768 };
export type DisplayMode = 'auto' | 'desktop';

/** Keep the complete desktop visible without changing its viewport or aspect ratio. */
export function fitDesktopViewport(width: number, height: number) {
  const scale = Math.max(0, Math.min(width / DESKTOP_RES.width, height / DESKTOP_RES.height));
  return {
    scale,
    left: Math.max(0, (width - DESKTOP_RES.width * scale) / 2),
    top: Math.max(0, (height - DESKTOP_RES.height * scale) / 2),
  };
}

/** Size the frame itself: object-fit does not resize an iframe's document. */
export function applyBrowserFrameDisplay(frame: HTMLIFrameElement, mode: DisplayMode, force = false): void {
  const bounds = frame.parentElement?.getBoundingClientRect();
  if (!bounds?.width || !bounds.height) return;
  const fit = fitDesktopViewport(bounds.width, bounds.height);
  Object.assign(frame.style, mode === 'desktop' ? {
    position: 'absolute', width: `${DESKTOP_RES.width}px`, height: `${DESKTOP_RES.height}px`,
    left: `${fit.left}px`, top: `${fit.top}px`, transform: `scale(${fit.scale})`, transformOrigin: '0 0',
  } : {
    position: 'absolute', width: '100%', height: '100%',
    left: '0px', top: '0px', transform: 'none', transformOrigin: '0 0',
  });
  if (!force && frame.dataset.timonDisplay === mode) return;
  try {
    const win = frame.contentWindow;
    if (!win) return;
    const origin = win.location.origin;
    win.postMessage({ type: 'setScaleLocally', value: true }, origin);
    win.postMessage(mode === 'desktop'
      ? { type: 'setManualResolution', ...DESKTOP_RES }
      : { type: 'resetResolutionToWindow' }, origin);
    frame.dataset.timonDisplay = mode;
  } catch { /* The remote client may not have loaded yet; retry on load. */ }
}
