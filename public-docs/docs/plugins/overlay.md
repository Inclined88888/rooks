---
title: Overlay
sidebar_position: 8
---

An overlay lives **inside the app window**, above its chrome. It is not an operating-system window and is not managed by the widget placement host.

Declare `kind: "overlay"` (or a list including it), include the exact `overlay` slot and register your component there. Position the component itself, for example using `position: fixed`. Keep pointer handling limited to the interactive content so it does not prevent use of the page underneath.

The supplied `plugin-overlay` has two insertions: a cockpit card and an overlay. It declares both kinds and both slots, registers both components and returns a disposer that releases both registrations.

In the desktop app, the built-in browser is painted above the page, so it hides whatever part of your overlay it overlaps. That is expected for something always on screen. If your overlay opens a panel the user has to reach, hold a [`NativeViewCover`](ui-kit.md#nativeviewcover) in that panel while it is open.

Use this one-identity approach when the surfaces represent the same feature. Use a [bundle](bundle.md) only when the children need separate identities, configuration or toggles.
