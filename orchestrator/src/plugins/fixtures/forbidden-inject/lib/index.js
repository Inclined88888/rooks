/**
 * Fixture : manifeste impeccable, `inject` qui réclame la base. Le manifeste
 * ne peut pas l'attraper (`inject` vit ici, pas dans le `package.json`) : c'est
 * le loader qui doit refuser, après l'import mais AVANT `apply`.
 */
export const name = 'fixture-forbidden'
export const inject = ['db']

export function apply() {
  ;(globalThis.__rooksFixtureTrace ??= []).push('forbidden:apply')
}
