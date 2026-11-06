/** Fixture : le plugin qui casse. Le daemon doit survivre, et ses voisins aussi. */
export const name = 'fixture-throws'

export function apply() {
  throw new Error('boum à l\'application')
}
