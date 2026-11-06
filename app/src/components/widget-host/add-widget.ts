/**
 * "Your widget here": the dashed card a fresh install shows where a widget
 * could go, whose + opens the widget window (the maintainer's request of 05/11/2026).
 *
 * It is a widget like the others, so it moves, docks and closes like them,
 * and a closed one stays closed (`removed`). Two registrations, because a
 * placement id is unique per view and `/agents` starts with one per column.
 * Product-internal: the widget window never lists them, a placeholder of a
 * widget is not a widget anyone would pick.
 */
import { idPlacementPlugin } from './widget-catalog';

export const ADD_WIDGET_MODULE = '@timon/ui-layout';
export const ADD_WIDGET_KEYS = ['add-widget', 'add-widget-2'] as const;

export const ADD_WIDGET_IDS: readonly string[] = ADD_WIDGET_KEYS.map((key) => idPlacementPlugin(ADD_WIDGET_MODULE, key));

export function isAddWidgetPlaceholder(id: string): boolean {
  return ADD_WIDGET_IDS.includes(id);
}
