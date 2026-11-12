/**
 * `--import` this (after `--import tsx`) in a child that runs `bin/rooks`. The
 * CLI loads the compiled `dist/<mod>.js`, which a worktree or a fresh checkout
 * does not have — and a test must never build the `dist/` the live daemon
 * runs. Those imports are pointed at `src/<mod>.ts` instead, compiled by tsx
 * like the rest of the suite.
 */
import { register } from 'node:module';

const HOOK = `
let dist;
let src;
export function initialize(data) { dist = data.dist; src = data.src; }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(dist) && specifier.endsWith('.js')) {
    return next(src + specifier.slice(dist.length, -'.js'.length) + '.ts', context);
  }
  return next(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(HOOK)}`, {
  data: { dist: new URL('../../dist/', import.meta.url).href, src: new URL('../../src/', import.meta.url).href },
});
