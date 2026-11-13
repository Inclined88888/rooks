'use client';

import type { BundledClientPlugin } from './types';

/** The local gallery lists what `@timon/plugins` serves on `/api/plugins`. */
export const corePluginsClient: BundledClientPlugin = {
  module: '@timon/plugins',
  apply(_ctx) {
    // The gallery is opened from Settings. A rail entry would be a second Plugins.
  },
};
