// d3-force-3d publishes no typings and has no @types package.
// Only what the vault graph actually consumes is declared.
declare module 'd3-force-3d' {
  /** A node as the simulation handles it: it writes x/y/z and vx/vy/vz
   *  straight onto it, and reads fx/fy/fz as position constraints. */
  interface SimNode {
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  /** After initialisation, `forceLink` replaces the source/target ids with
   *  the node objects themselves. Hence the union: before/after resolution. */
  interface SimLink<N> {
    source: string | N;
    target: string | N;
  }

  interface Force {
    (alpha: number): void;
  }

  interface RadialForce extends Force {
    strength(strength: number): RadialForce;
    radius(radius: number): RadialForce;
  }

  interface LinkForce<N> extends Force {
    id(accessor: (node: N) => string): LinkForce<N>;
    distance(distance: number | ((link: SimLink<N>) => number)): LinkForce<N>;
    strength(strength: number | ((link: SimLink<N>) => number)): LinkForce<N>;
    links(links: SimLink<N>[]): LinkForce<N>;
  }

  interface ManyBodyForce extends Force {
    strength(strength: number): ManyBodyForce;
    distanceMax(distance: number): ManyBodyForce;
  }

  interface CenterForce extends Force {
    strength(strength: number): CenterForce;
  }

  interface Simulation<N> {
    nodes(): N[];
    nodes(nodes: N[]): Simulation<N>;
    force(name: string, force: Force | null): Simulation<N>;
    alpha(): number;
    alpha(alpha: number): Simulation<N>;
    alphaMin(min: number): Simulation<N>;
    alphaDecay(decay: number): Simulation<N>;
    alphaTarget(target: number): Simulation<N>;
    velocityDecay(decay: number): Simulation<N>;
    tick(iterations?: number): Simulation<N>;
    stop(): Simulation<N>;
    restart(): Simulation<N>;
  }

  /** `numDimensions` defaults to 2 — setting it to 3 is NOT optional for a
   *  3D graph, otherwise the simulation produces a flat disc. */
  export function forceSimulation<N extends SimNode>(
    nodes?: N[],
    numDimensions?: number,
  ): Simulation<N>;

  export function forceLink<N>(links?: SimLink<N>[]): LinkForce<N>;
  export function forceManyBody(): ManyBodyForce;
  export function forceCenter(x?: number, y?: number, z?: number): CenterForce;
  export function forceRadial(
    radius: number,
    x?: number,
    y?: number,
    z?: number,
  ): RadialForce;
}
