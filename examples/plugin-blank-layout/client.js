import React from 'react';
import { SlotKeyed } from '@rooks/ui';

export function apply(ctx) {
  return ctx.slots.register(
    // `page` is keyed by route: a layout paints the Next tree's reserved
    // key, never the whole slot — every plugin page would stack up.
    { slot: 'root', children: { page: 'keyed' } },
    function BlankLayout() { return React.createElement(SlotKeyed, { name: 'page', entryKey: 'next-router' }); },
  );
}
