/**
 * The Rooks mark: a chess-rook tower (merlons + arched doorway), drawn in a
 * box of its own. It carries no colour on the body: the screen paints it
 * (`currentColor`) so it follows the theme. The doorway is a hole (evenodd).
 */
export const ROOKS_MARK = Object.freeze({
  viewBox: '64 64 896 896',
  /** Width over height: square tile. */
  ratio: 1,
  /** Tower body with door cut out (fill-rule: evenodd). */
  d: [
    'M288 248A24 24 0 0 1 312 224H379V336H467V224H557V336H645V224H712A24 24 0 0 1 736 248V760A48 48 0 0 1 688 808H336A48 48 0 0 1 288 760Z',
    'M448 808V624A64 64 0 0 1 576 624V808Z',
  ].join(' '),
  fillRule: 'evenodd' as const,
});
