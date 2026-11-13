import React, { type ReactElement } from 'react';
import { DEFAULT_APPEARANCE, appearanceCss, type NativeAppearance } from '@/plugins-client/ui-theme-variants';
import { THEME_TOKENS_CSS } from '@/plugins-client/ui-theme-tokens';
import { ROOKS_THEME_PLUGIN, ROOKS_THEME_TOKENS_CSS } from '@/plugins-client/theme-rooks-floor';

/** Stable id: tests look for it, and a debugger needs to tell the two apart. */
export const THEME_FLOOR_STYLE_ID = 'rooks-theme-floor';

/**
 * The palette floor — the tokens that paint when nothing else does.
 *
 * The `theme` slot is `single` with a default occupant, so it normally always
 * has a painter. "Normally" is the problem: a viewer whose theme surfaces are
 * curtained off, a third-party theme that defines 40 of the 125 tokens, a
 * claimant that unmounts on an error — each leaves custom properties
 * undefined, and an undefined token is not a fallback colour, it is an invalid
 * declaration. The app then renders with no background, no border and no
 * accent, including the gallery you would have to reach to undo it.
 *
 * So the shell paints the same tokens unconditionally, wrapped in a cascade
 * layer. An unlayered declaration beats ANY layer, whatever the document
 * order, so this changes nothing while a theme paints: the `<style>` of the
 * occupant (product or third-party) is unlayered and wins every token it
 * defines. What it wins are the tokens nobody defined.
 *
 * Native `@layer`, not Tailwind's `@layer base` directive: the latter is a
 * PostCSS instruction that inlines rules into the base section of the output,
 * with ordinary specificity — it would have made this a source-order race.
 *
 * Consequence, accepted: a viewer denied `theme:ui-theme` (M.4) no longer
 * gets an unstyled page, they get the product palette with no way to change
 * it. A palette is chrome, not data; a broken page was the worse answer.
 */
/**
 * `theme`: the account's theme. When it is the built-in Rooks theme, a copy
 * of its tokens is painted in the floor too, after the product's: the page
 * then has its colours before the plugin's bundle is fetched and its own
 * `<style>` mounts, instead of flashing the product palette first. Its glows
 * stay with the plugin.
 */
export function ThemeFloor({ appearance = DEFAULT_APPEARANCE, theme }: { appearance?: NativeAppearance; theme?: string } = {}): ReactElement {
  const rooks = theme === ROOKS_THEME_PLUGIN ? ROOKS_THEME_TOKENS_CSS : '';
  return (
    <style
      id={THEME_FLOOR_STYLE_ID}
      dangerouslySetInnerHTML={{ __html: `@layer rooks-floor {${THEME_TOKENS_CSS}${appearanceCss(appearance)}${rooks}}` }}
    />
  );
}
