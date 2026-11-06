/**
 * Compile-time type equality, for the guards that keep the hand-written plugin
 * contract (`plugins/contract/`) and the constant or schema it describes in
 * step (TODO #512). The contract cannot derive its unions from the runtime
 * (`typeof X[number]`, `z.infer`): it would import the implementation into the
 * public SDK. So it spells them out, and the implementation proves at
 * compilation that both say the same thing.
 *
 * Mutual `extends` would let a `readonly` or optional difference through; the
 * identity relation used here does not.
 */
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

export type Assert<T extends true> = T;
