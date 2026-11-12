/**
 * What tells a line-oriented session from a protocol one, in a module of its own:
 * a provider reads it from the SDK package without loading the driver itself,
 * which it now gets from `ctx.provider.runtime`.
 */
import type { SessionDriver } from '../types.js';
import type { LineSessionDriver } from './lines-driver.js';

/** Brand read by `isLineSessionDriver`. A symbol from the global registry, so a
 *  driver built from another copy of this module (a provider plugin carries its
 *  own) is still recognised: the answer must not depend on which `class` made it. */
export const LINE_SESSION_DRIVER: unique symbol = Symbol.for('rooks.lineSessionDriver');

/** The test for "this session is a process's lines, not a protocol" — never a name. */
export function isLineSessionDriver(driver: SessionDriver): driver is LineSessionDriver {
  return Reflect.get(driver, LINE_SESSION_DRIVER) === true;
}
