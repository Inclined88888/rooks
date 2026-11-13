// ---------------------------------------------------------------------------
// three.js scene of the vault graph — instanced rendering.
//
// WHY THIS MODULE EXISTS
//
// `3d-force-graph` creates one three.js object PER graph element: a sphere
// `Mesh` per node and — as soon as `linkWidth` is non-zero — a cylinder `Mesh`
// per link. On the vault (496 nodes, 2,415 links) that is 2,911 objects in the
// scene, so ~2,900 draw calls and as many world-matrix updates, frustum tests
// and uniform uploads, ON EVERY FRAME.
//
// Measured on 2026-08-26: 25,212 draw calls/s, 17,000 `uniformMatrix4fv`/s.
// Above all, with draw calls neutralised at the WebGL context level, the cost
// only fell from 18.5% to 16.8% of a core: the GPU was doing almost nothing,
// all the time went into three.js per-object CPU work. The cost is therefore
// proportional to the NUMBER OF OBJECTS, not to pixels (the canvas is
// 374×377) nor to triangles.
//
// Hence this module: the 496 nodes become ONE `InstancedMesh`, the 2,415 links
// ONE `LineSegments`. Two objects, two draw calls, whatever the vault size.
// The force simulation stays `d3-force-3d`, the same one `3d-force-graph` used
// under the hood — the layout does not change.
//
// This module deliberately has no React: it is an imperative handle that the
// component drives. It imports `three`, so it must never be evaluated on the
// server — callers get it through `await import()`.
// ---------------------------------------------------------------------------
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshLambertMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
} from 'd3-force-3d';

export interface SceneNode {
  id: string;
  title: string;
  folder: string;
  degree: number;
  // Written by the simulation.
  x?: number;
  y?: number;
  z?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

export interface SceneLink {
  source: string | SceneNode;
  target: string | SceneNode;
}

export interface SceneOptions {
  container: HTMLElement;
  width: number;
  height: number;
  nodes: SceneNode[];
  links: SceneLink[];
  /** CSS colour of a node, resolved once at construction. */
  nodeColor: (node: SceneNode) => string;
  /** Apparent radius of a node. */
  nodeRadius: (node: SceneNode) => number;
  linkColor: string;
  linkOpacity: number;
  /** Cruising frame rate at the wide framing. The scene raises it itself when
   *  zooming in — see `cadenceSouhaitee`. */
  cadenceBase: number;
  onClick: (node: SceneNode) => void;
  /** Any user gesture — used to pause the automatic rotation. */
  onInteract: () => void;
}

// Lighting copied as is from `3d-force-graph` so nodes look exactly as they did
// before the switch (ambient strongly dominant).
const AMBIANTE = 0xcccccc;
const DIRECTIONNELLE = 0xffffff;

// `nodeResolution` was 6: a coarse sphere, invisible at the size nodes are
// drawn. With instancing the geometry is shared by the 496 instances — so we
// can afford to be a little finer without costing anything in draw calls.
const SEGMENTS_SPHERE = 8;

/** Step budget of the force engine.
 *
 *  240 + 60, taken from the old library, were NOT enough: measured, the cloud
 *  topped out at a radius of ~79 — d3's initial spiral — instead of the 180
 *  aimed at by the radial force. With `velocityDecay` at 0.75 nodes are heavily
 *  damped and need many more iterations to spread out.
 *
 *  Warm-up is pure computation, run in one go before the first frame: 300
 *  steps on 496 nodes cost a few tens of milliseconds and nothing on screen.
 *  The rest plays out during the first frames. */
const PAS_REFROIDISSEMENT = 600;
const PAS_PRECHAUFFAGE = 300;
const ALPHA_DECAY = 0.015;
const VELOCITY_DECAY = 0.75;

const RAYON_SPHERE = 180;
const FORCE_SPHERE = 0.12;

/** Rotation: degrees per second, independent of the render rate. */
export const VITESSE_ROTATION_DEG_S = 1.2;

/** How long rendering stays at full vsync after the last gesture. Long enough
 *  to cover the gaps between two mouse events and the controls settling,
 *  short enough not to prolong the cost. */
const TRAINE_GESTE_MS = 400;

/** Ceiling of the zoom-adaptive frame rate — see `cadenceSouhaitee`. */
const CADENCE_MAX = 60;

/** Hover delay before a node's label shows.
 *
 *  Without it, sweeping across the graph flashes a label for every node
 *  crossed. Half a second separates "passing over" from "looking at this one",
 *  and the count restarts from zero whenever the hovered node changes. */
const DELAI_ETIQUETTE_MS = 500;

export class VaultGraphScene {
  private readonly opts: SceneOptions;
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly controls: TrackballControls;
  private readonly noeuds: InstancedMesh;
  private readonly liens: LineSegments;
  private readonly positionsLiens: Float32Array;
  private readonly geometrieLiens: BufferGeometry;
  private readonly simulation: ReturnType<typeof forceSimulation<SceneNode>>;
  private readonly matrice = new Matrix4();
  private readonly rayon = new Raycaster();
  private readonly pointeur = new Vector2();
  private readonly rayons: number[];
  /** Label following the cursor. Driven through the DOM directly rather than
   *  React state: the position changes on every `pointermove`, and state would
   *  trigger one React render per mouse move. */
  private readonly etiquette: HTMLDivElement;

  private pasEcoules = 0;
  private simulationActive = true;
  /** Positions only moved if the simulation ran or a node is being dragged.
   *  Otherwise a frame rewrites NO buffer: that is what makes a high frame
   *  rate truly free. */
  private positionsSales = true;
  private rotationActive = true;
  private dernierRendu = 0;

  private survole: SceneNode | null = null;
  private tire: SceneNode | null = null;
  private profondeurTire = 0;
  private detruit = false;
  /** Press position, to tell a click from a drag on release. */
  private appuiEn: { x: number; y: number } | null = null;
  private aGlisse = false;
  /** True from the first camera gesture on: stops the automatic reframing. */
  private cameraPriseEnMain = false;
  /** Timestamp of the last user gesture (orbit, wheel, drag).
   *
   *  During a gesture the cruising rate is not tenable: `TrackballControls`
   *  accumulates mouse input but only applies it to the camera on its
   *  `update()`, called once per frame. At RENDER_FPS, orbiting the graph with
   *  the mouse gave a rotation that advanced only twelve times per second —
   *  it felt like "2 fps". A gesture must render at full vsync. */
  private dernierGesteMs = 0;
  /** Camera distance kept from the last automatic framing: the reference for
   *  the zoom factor of the adaptive frame rate. */
  private distanceCadrage = 0;
  /** Timer of the hover delay, for the node it is waiting to announce. */
  private minuterieEtiquette: ReturnType<typeof setTimeout> | null = null;
  /** Visible ids, or `null` when no filter is active. */
  private filtre: Set<string> | null = null;

  constructor(opts: SceneOptions) {
    this.opts = opts;

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(opts.width, opts.height, false);
    this.renderer.setClearColor(0x000000, 0);
    opts.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    // Recreates the label `3d-force-graph` showed near the cursor. Its native
    // version wrote in light lavender, unreadable on the graph's light
    // background: hence these inline styles, copied as is from the old
    // `nodeLabel`.
    this.etiquette = document.createElement('div');
    Object.assign(this.etiquette.style, {
      position: 'absolute', zIndex: '20', pointerEvents: 'none', display: 'none',
      padding: '3px 8px', borderRadius: '6px',
      background: 'rgba(28,26,24,0.88)', color: '#fdf6f0',
      border: '1px solid rgba(255,255,255,0.12)',
      fontFamily: 'var(--font-sans), system-ui, sans-serif', fontSize: '11px',
      whiteSpace: 'nowrap', textShadow: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    opts.container.appendChild(this.etiquette);

    this.scene = new Scene();
    this.scene.add(new AmbientLight(AMBIANTE, Math.PI));
    this.scene.add(new DirectionalLight(DIRECTIONNELLE, 0.6 * Math.PI));

    this.camera = new PerspectiveCamera(50, opts.width / opts.height, 0.1, 20000);
    this.camera.position.set(0, 0, 600);

    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.minDistance = 10;
    this.controls.maxDistance = 5000;
    this.controls.rotateSpeed = 1.2;
    this.controls.zoomSpeed = 1.2;
    // Without damping the camera stops dead on release; with it, it keeps
    // drifting — and would therefore need continuous rendering. Disabled on
    // purpose: that is the price of a scene that only draws on demand.
    this.controls.staticMoving = true;

    // ---- nodes: a single InstancedMesh ------------------------------------
    const geoNoeud = new SphereGeometry(1, SEGMENTS_SPHERE, SEGMENTS_SPHERE);
    const matNoeud = new MeshLambertMaterial();
    this.noeuds = new InstancedMesh(geoNoeud, matNoeud, opts.nodes.length);
    this.noeuds.instanceMatrix.setUsage(DynamicDrawUsage);
    // An InstancedMesh's bounding sphere is computed from the GEOMETRY (here a
    // radius of 1), not from the instances spread over ~400 units. Leaving
    // culling on would make the whole graph vanish as soon as the camera moves
    // away from the origin — and that reads as a controls bug.
    this.noeuds.frustumCulled = false;

    const couleur = new Color();
    this.rayons = opts.nodes.map((n) => opts.nodeRadius(n));
    opts.nodes.forEach((n, i) => {
      couleur.set(opts.nodeColor(n));
      this.noeuds.setColorAt(i, couleur);
    });
    if (this.noeuds.instanceColor) this.noeuds.instanceColor.needsUpdate = true;
    this.scene.add(this.noeuds);

    // ---- links: a single LineSegments --------------------------------------
    // Two vertices per link, written flat. `LineBasicMaterial.linewidth` is
    // ignored by WebGL on every platform: links become one-pixel filaments
    // instead of the former 0.35 tubes. That is the only visual difference of
    // the switch, and it is deliberate — the tube cost one three.js object per
    // link, 83% of the scene's budget.
    this.positionsLiens = new Float32Array(opts.links.length * 2 * 3);
    this.geometrieLiens = new BufferGeometry();
    const attribut = new BufferAttribute(this.positionsLiens, 3);
    attribut.setUsage(DynamicDrawUsage);
    this.geometrieLiens.setAttribute('position', attribut);
    this.liens = new LineSegments(
      this.geometrieLiens,
      new LineBasicMaterial({
        color: new Color(opts.linkColor),
        transparent: true,
        opacity: opts.linkOpacity,
        depthWrite: false,
      }),
    );
    this.liens.frustumCulled = false;
    this.scene.add(this.liens);

    // ---- simulation --------------------------------------------------------
    // CRITICAL ORDER. `forceSimulation` itself places the nodes on an initial
    // spiral (radius 10·∛n, ~79 for 496 nodes) AS SOON AS IT IS CONSTRUCTED.
    // The "is this layout already computed?" test must therefore run BEFORE
    // it: placed after, it is always true, warm-up is skipped and the graph
    // stays frozen on that spiral, never relaxed — 496 nodes packed into a
    // ball three times too small.
    const dejaCalcule = opts.nodes.length > 0 && opts.nodes[0]!.x !== undefined;

    // Same forces `3d-force-graph` installed by default, plus the radial force
    // that rounds the vault into a ball. The `3` is not decorative:
    // `forceSimulation` works in 2D by default.
    this.simulation = forceSimulation<SceneNode>(opts.nodes, 3)
      .force('link', forceLink<SceneNode>(opts.links).id((n) => n.id))
      .force('charge', forceManyBody())
      .force('center', forceCenter())
      .force('radial', forceRadial(RAYON_SPHERE).strength(FORCE_SPHERE))
      .alphaDecay(ALPHA_DECAY)
      .velocityDecay(VELOCITY_DECAY)
      .stop();

    // An already relaxed layout is reused as is: switching to full screen must
    // not replay the settling. `forceLink` does not mind, it only resolves
    // `source`/`target` when they are not already node objects.
    if (dejaCalcule) {
      this.simulationActive = false;
      this.pasEcoules = PAS_REFROIDISSEMENT;
    } else {
      // Warm-up runs in one go, before the first frame: without it the initial
      // cloud would be seen unfolding.
      this.simulation.tick(PAS_PRECHAUFFAGE);
      this.pasEcoules = PAS_PRECHAUFFAGE;
    }

    this.attacherEvenements();
    this.majPositions();
    this.cadrer();
  }

  // -------------------------------------------------------------------------
  // Render loop — called by the component, never self-scheduled here.
  // -------------------------------------------------------------------------
  rendre(): void {
    if (this.detruit) return;

    const maintenant = performance.now();
    const dt = this.dernierRendu ? (maintenant - this.dernierRendu) / 1000 : 0;
    this.dernierRendu = maintenant;

    if (this.simulationActive) {
      this.simulation.tick();
      this.pasEcoules++;
      this.positionsSales = true;
      if (this.pasEcoules >= PAS_REFROIDISSEMENT) this.simulationActive = false;
      // The cloud keeps spreading throughout cooling: framing it only once at
      // construction let it overflow the panel. So we follow its spread —
      // unless the user has already taken the camera, in which case snatching
      // their framing away would be worse than anything.
      if (!this.cameraPriseEnMain) this.cadrer();
    }

    if (this.positionsSales) {
      this.majPositions();
      this.positionsSales = false;
    }

    if (this.rotationActive && dt > 0) {
      // Speed is in degrees per SECOND, derived from elapsed time: it does not
      // depend on the render rate. Changing that rate changes smoothness, never
      // the apparent speed.
      const p = this.camera.position;
      const d = Math.sqrt(p.x * p.x + p.z * p.z);
      const a = Math.atan2(p.x, p.z) + (VITESSE_ROTATION_DEG_S * Math.PI) / 180 * dt;
      p.x = d * Math.sin(a);
      p.z = d * Math.cos(a);
      this.camera.lookAt(0, 0, 0);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Copies the simulation positions into the two GPU buffers. It is the only
   *  place that writes to video memory, and it is only called when something
   *  actually moved. */
  private majPositions(): void {
    const noeuds = this.opts.nodes;
    for (let i = 0; i < noeuds.length; i++) {
      const n = noeuds[i]!;
      const r = this.visible(n) ? this.rayons[i]! : 0;
      this.matrice.makeScale(r, r, r);
      this.matrice.setPosition(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      this.noeuds.setMatrixAt(i, this.matrice);
    }
    this.noeuds.instanceMatrix.needsUpdate = true;

    const liens = this.opts.links;
    const pos = this.positionsLiens;
    for (let i = 0; i < liens.length; i++) {
      const l = liens[i]!;
      // `forceLink` replaces ids with node objects during its initialisation;
      // before that pass, source/target are still strings and there is nothing
      // to draw.
      const s = l.source as SceneNode;
      const t = l.target as SceneNode;
      const o = i * 6;
      // A link is drawn only if BOTH ends are visible: otherwise it is reduced
      // to a point, which draws nothing.
      const trace = s && t && this.visible(s) && this.visible(t);
      pos[o] = s?.x ?? 0;
      pos[o + 1] = s?.y ?? 0;
      pos[o + 2] = s?.z ?? 0;
      pos[o + 3] = trace ? (t?.x ?? 0) : (s?.x ?? 0);
      pos[o + 4] = trace ? (t?.y ?? 0) : (s?.y ?? 0);
      pos[o + 5] = trace ? (t?.z ?? 0) : (s?.z ?? 0);
    }
    this.geometrieLiens.attributes.position!.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------
  private attacherEvenements(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.surDeplacement);
    el.addEventListener('pointerdown', this.surAppui);
    el.addEventListener('pointerup', this.surRelache);
    el.addEventListener('pointerleave', this.surSortie);
    el.addEventListener('wheel', this.surInteraction, { passive: true });
  }

  /** The cursor leaves the canvas: release any drag AND clear the hover,
   *  otherwise the label would stay stuck to the panel edge. */
  private surSortie = (ev: PointerEvent): void => {
    this.surRelache(ev);
    this.survole = null;
    this.masquerEtiquette();
  };

  private surInteraction = (): void => {
    this.cameraPriseEnMain = true;
    this.dernierGesteMs = performance.now();
    this.opts.onInteract();
  };

  /** Returns the node under the pointer, or null. A raycast on an
   *  `InstancedMesh` provides `instanceId`, which is the index in our array. */
  private noeudSous(ev: PointerEvent): SceneNode | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointeur.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this.pointeur.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    this.rayon.setFromCamera(this.pointeur, this.camera);
    const touches = this.rayon.intersectObject(this.noeuds, false);
    const premier = touches[0];
    if (!premier || premier.instanceId == null) return null;
    return this.opts.nodes[premier.instanceId] ?? null;
  }

  private surDeplacement = (ev: PointerEvent): void => {
    if (this.appuiEn) {
      const d = Math.hypot(ev.clientX - this.appuiEn.x, ev.clientY - this.appuiEn.y);
      // 4 px of tolerance: even a clean click always moves a little.
      if (d > 4) this.aGlisse = true;
      // Button held = gesture in progress: keep the full frame rate.
      this.dernierGesteMs = performance.now();
    }
    if (this.tire) {
      this.deplacerTire(ev);
      return;
    }
    // During an orbit hovering means nothing, and the raycast would cost 496
    // instance tests on every mouse move, for nothing.
    if (this.appuiEn) return;
    const n = this.noeudSous(ev);
    if (n !== this.survole) {
      this.survole = n;
      this.renderer.domElement.style.cursor = n ? 'pointer' : '';
      // New node = the count restarts. Crossing the graph therefore shows no
      // label until the pointer stops on one of them.
      this.masquerEtiquette();
      if (n) {
        const x = ev.clientX, y = ev.clientY;
        this.minuterieEtiquette = setTimeout(() => {
          this.minuterieEtiquette = null;
          if (this.survole !== n || this.detruit) return;
          this.etiquette.textContent = n.title;
          this.etiquette.style.display = 'block';
          this.placerEtiquetteEn(x, y);
        }, DELAI_ETIQUETTE_MS);
      }
    }
    // Once shown, the label follows the cursor without rearming the delay.
    if (this.etiquette.style.display === 'block') this.placerEtiquette(ev);
  };

  private masquerEtiquette(): void {
    if (this.minuterieEtiquette) {
      clearTimeout(this.minuterieEtiquette);
      this.minuterieEtiquette = null;
    }
    this.etiquette.style.display = 'none';
  }

  /** Sticks the label to the cursor, flipping it to the left or above when it
   *  would overflow the panel — otherwise it would be cut near the edges. */
  private placerEtiquette(ev: PointerEvent): void {
    this.placerEtiquetteEn(ev.clientX, ev.clientY);
  }

  private placerEtiquetteEn(clientX: number, clientY: number): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    let x = clientX - r.left + 12;
    let y = clientY - r.top + 12;
    const l = this.etiquette.offsetWidth;
    const h = this.etiquette.offsetHeight;
    if (x + l > r.width) x = Math.max(0, clientX - r.left - l - 12);
    if (y + h > r.height) y = Math.max(0, clientY - r.top - h - 12);
    this.etiquette.style.left = `${x}px`;
    this.etiquette.style.top = `${y}px`;
  }

  private surAppui = (ev: PointerEvent): void => {
    this.surInteraction();
    this.appuiEn = { x: ev.clientX, y: ev.clientY };
    this.aGlisse = false;
    const n = this.noeudSous(ev);
    if (!n) return;
    // A press on a node starts a drag; the controls are disabled so the camera
    // does not move along with the node.
    this.tire = n;
    this.controls.enabled = false;
    this.profondeurTire = new Vector3(n.x ?? 0, n.y ?? 0, n.z ?? 0)
      .project(this.camera).z;
    this.renderer.domElement.setPointerCapture(ev.pointerId);
  };

  private deplacerTire(ev: PointerEvent): void {
    const n = this.tire;
    if (!n) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    // Unproject the pointer at the screen depth the node had when pressed: the
    // node follows the mouse in the plane that faced it, without jumping
    // towards or away from the camera.
    const p = new Vector3(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
      this.profondeurTire,
    ).unproject(this.camera);
    n.fx = p.x;
    n.fy = p.y;
    n.fz = p.z;
    // A moved node must pull its neighbours: reheat the simulation.
    this.simulation.alpha(0.3);
    this.simulationActive = true;
    this.pasEcoules = 0;
    this.positionsSales = true;
  }

  private surRelache = (ev: PointerEvent): void => {
    // Release without drag on a node = click: open the note. Handled here
    // rather than with a separate `click` listener, which would also fire at
    // the end of a drag and open the note that was just moved.
    if (this.appuiEn && !this.aGlisse) {
      const n = this.noeudSous(ev);
      if (n) {
        // The modal covers the canvas: without this the label would stay frozen
        // behind it, since `pointerleave` never happens.
        this.masquerEtiquette();
        this.opts.onClick(n);
      }
    }
    if (this.appuiEn) {
      // The full-rate tail runs from the RELEASE, not from the last move: the
      // controls still have a few frames to play.
      this.dernierGesteMs = performance.now();
    }
    this.appuiEn = null;

    if (!this.tire) return;
    const n = this.tire;
    // Release the constraint: the node returns to its place under the forces
    // instead of staying pinned where it was dropped.
    n.fx = null;
    n.fy = null;
    n.fz = null;
    this.tire = null;
    this.controls.enabled = true;
    try {
      this.renderer.domElement.releasePointerCapture(ev.pointerId);
    } catch {
      // the pointer may already have been released (pointerleave)
    }
  };

  // -------------------------------------------------------------------------
  // Driven from the component
  // -------------------------------------------------------------------------
  redimensionner(width: number, height: number): void {
    if (this.detruit || width <= 0 || height <= 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.controls.handleResize();
    // Framing depends on the aspect ratio: the HUD panel is resizable, and a
    // cloud framed to the pixel would overflow otherwise.
    if (!this.cameraPriseEnMain) this.cadrer();
  }

  definirRotation(active: boolean): void {
    this.rotationActive = active;
  }

  /** Reframes the camera on the actual extent of the cloud.
   *
   *  The HUD panel is almost square and can become taller than wide: so the
   *  tighter of the two half field-of-view angles is used. Settling for the
   *  vertical field let the cloud overflow sideways. */
  cadrer(marge = 1.3): void {
    let max = 0;
    for (const n of this.opts.nodes) {
      const d = Math.sqrt((n.x ?? 0) ** 2 + (n.y ?? 0) ** 2 + (n.z ?? 0) ** 2);
      if (d > max) max = d;
    }
    if (max <= 0) return;
    const demiVertical = (this.camera.fov * Math.PI) / 360;
    const demiHorizontal = Math.atan(Math.tan(demiVertical) * this.camera.aspect);
    const demi = Math.min(demiVertical, demiHorizontal);
    const distance = (max * marge) / Math.sin(demi);
    const p = this.camera.position;
    const actuelle = p.length() || 1;
    p.multiplyScalar(distance / actuelle);
    this.camera.lookAt(0, 0, 0);
    this.distanceCadrage = distance;
  }

  /** True when the scene must render at full vsync rather than RENDER_FPS:
   *  layout settling, a node being dragged, or a camera gesture in progress.
   *
   *  The tail after the last gesture covers two things: mouse events do not
   *  arrive at regular intervals (dropping the rate between two `pointermove`
   *  would make the orbit stutter), and `TrackballControls` needs a few frames
   *  after release to settle. */
  get enMouvement(): boolean {
    return this.simulationActive
      || this.tire !== null
      || performance.now() - this.dernierGesteMs < TRAINE_GESTE_MS;
  }

  /** Cruising frame rate to aim for, in frames per second.
   *
   *  It must GO UP when zooming in. Rotation advances by a fixed angular step,
   *  but the displacement that step produces ON SCREEN is inversely
   *  proportional to the camera distance: at the wide framing 12 frames/s are
   *  enough and motion is smooth; zoomed four times, the same step covers four
   *  times more pixels per frame and the rotation stutters. Checked by
   *  measurement: the rate did stay at 12 fps and 2 draw calls per frame while
   *  zooming — the defect is perceptual, not a lack of performance, so it is
   *  fixed by the frame rate, not by rendering.
   *
   *  The cost grows linearly (~0.7% of a core per frame/second), but it is
   *  only paid when zoomed in, that is when someone really looks at the graph. */
  get cadenceSouhaitee(): number {
    const base = this.opts.cadenceBase;
    if (!this.distanceCadrage) return base;
    const distance = this.camera.position.length() || this.distanceCadrage;
    const zoom = this.distanceCadrage / distance;
    return Math.min(CADENCE_MAX, Math.max(base, base * zoom));
  }

  /** Restricts the display to the given ids — `null` lifts the filter.
   *
   *  NEITHER the simulation NOR the scene structure is touched: hidden nodes
   *  go to scale 0 and their links become zero-length segments, hence
   *  invisible. The layout does not move (nothing is more disorienting than a
   *  graph that rearranges at every typed letter), and the draw call count
   *  stays at two. A node at scale 0 has a zero radius: the raycast no longer
   *  reaches it, so it also becomes unhoverable and unclickable, for free. */
  definirFiltre(ids: Set<string> | null): void {
    this.filtre = ids;
    this.positionsSales = true;
    this.masquerEtiquette();
  }

  private visible(n: SceneNode): boolean {
    return this.filtre === null || this.filtre.has(n.id);
  }

  /** Recolours the scene without rebuilding anything.
   *
   *  The theme changes colours, never geometry: rebuilding the scene would
   *  replay the layout for a mere light/dark switch. So the instances' colour
   *  attribute and the links' material are rewritten instead. */
  definirTheme(theme: {
    nodeColor: (node: SceneNode) => string;
    linkColor: string;
    linkOpacity: number;
  }): void {
    const couleur = new Color();
    this.opts.nodes.forEach((n, i) => {
      couleur.set(theme.nodeColor(n));
      this.noeuds.setColorAt(i, couleur);
    });
    if (this.noeuds.instanceColor) this.noeuds.instanceColor.needsUpdate = true;

    const mat = this.liens.material as LineBasicMaterial;
    mat.color.set(theme.linkColor);
    mat.opacity = theme.linkOpacity;
    mat.needsUpdate = true;
  }

  detruire(): void {
    if (this.detruit) return;
    this.detruit = true;

    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.surDeplacement);
    el.removeEventListener('pointerdown', this.surAppui);
    el.removeEventListener('pointerup', this.surRelache);
    el.removeEventListener('pointerleave', this.surSortie);
    el.removeEventListener('wheel', this.surInteraction);

    if (this.minuterieEtiquette) clearTimeout(this.minuterieEtiquette);
    this.simulation.stop();
    this.controls.dispose();

    this.noeuds.geometry.dispose();
    (this.noeuds.material as MeshLambertMaterial).dispose();
    this.geometrieLiens.dispose();
    (this.liens.material as LineBasicMaterial).dispose();

    // The container is unmounted/remounted on every state change of the
    // component. Without an explicit release each pass would leave a WebGL
    // context alive — and a browser caps their number per page (~16), after
    // which the oldest is killed and the canvas goes black.
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
    this.etiquette.remove();
  }
}
