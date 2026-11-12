'use client';

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Slot, SlotKeyed } from './render';
import { UI_KIT } from './ui-kit';

declare global {
  var __ROOKS_PLATFORM__: {
    react: typeof React;
    reactDom: typeof ReactDOM;
    Slot: typeof Slot;
    SlotKeyed: typeof SlotKeyed;
    ui: typeof UI_KIT;
    api: typeof fetch;
    theme: { current(): 'light' | 'dark' };
    navigate(href: string): void;
  };
}

if (typeof window !== 'undefined') {
  globalThis.__ROOKS_PLATFORM__ = {
    react: React, reactDom: ReactDOM, Slot, SlotKeyed, ui: UI_KIT, api: fetch.bind(globalThis),
    theme: { current: () => document.documentElement.classList.contains('dark') ? 'dark' : 'light' },
    navigate: (href) => window.location.assign(href),
  };
}

export function PlatformGlobals(): null { return null; }
