import { MACHINES_MODULE } from '@/lib/machines/fleet';
import type { SettingsTarget } from '@/lib/settings-layout';

/** Settings → Machines: the plugin's own category, keyed by its module id. */
export const MACHINES_SETTINGS_TARGET: SettingsTarget = { category: 'plugins', tab: MACHINES_MODULE };
