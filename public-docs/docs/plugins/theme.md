---
title: Theme
sidebar_position: 9
---

A theme provides tokens through the single `theme` slot. Declare `kind: "theme"` and `client.slots: ["theme"]`; no host half is needed.

Register a component returning a React-managed `<style>` element with a stable ID. Unmounting it removes its CSS and restores the product fallback without a page reload.

## Supply both palettes

Timon's app uses `:root` for the dark palette and `.light` for the light palette. Supply both. This is the **Timon plugin** convention, distinct from the light/dark attribute used by this documentation website.

The complete `plugin-theme` template covers surfaces, shadows, component tokens, brand colours, calendars, syntax highlighting, grid and scrollbar tokens. A partial palette is valid: the permanent `timon-floor` cascade layer supplies omitted values. Unlayered plugin declarations override the floor for the tokens they define.

:::warning Keep geometry out of themes
Do not override `--timon-topbar-h`, `--timon-nav-w` or `--timon-browser-w`. These are measured runtime layout values. Replace geometry through a layout plugin.
:::

## Selection and access

Installation alone does not apply a theme. The client mounts the theme selected in the user's Appearance preferences alongside the product fallback. Other installed themes stay available in the gallery without painting.

The viewer must also have access to the plugin/theme permission target. A theme the viewer cannot use does not expose its client bundle to that viewer. Test switching, disabling and both colour modes.
