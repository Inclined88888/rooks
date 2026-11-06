import { shellText } from './shell-i18n.js';

/**
 * The page asked to keep the user — a document with unsaved changes
 * (TIM-0128) sets `beforeunload`. A browser asks on its own; Electron does
 * not: it refuses the close, the reload or the quit in silence unless the
 * shell answers `will-prevent-unload`. This is the question it asks.
 */
export type UnloadPrompt = {
  type: 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: true;
};

/** Index of the button that lets the window go. */
export const LEAVE = 0;

export function unloadPrompt(locale: string, title: string): UnloadPrompt {
  const t = shellText(locale);
  return {
    type: 'warning',
    title,
    message: t('unload.message'),
    detail: t('unload.detail'),
    buttons: [t('unload.leave'), t('unload.stay')],
    // Enter and Escape both keep the changes: losing them takes a click.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
