const matches = (pathname: string | null, route: string): boolean =>
  pathname === route || (route !== '/' && (pathname?.startsWith(route + '/') ?? false));

/** An entry is lit on its own route and on the routes it declares as aliases. */
export function isNavItemActive(
  pathname: string | null,
  href: string,
  activeRoutes: readonly string[] = [],
): boolean {
  return [href, ...activeRoutes].some((route) => matches(pathname, route));
}
