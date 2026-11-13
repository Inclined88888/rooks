'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { useColorScheme } from '@/components/theme-provider';
import VaultNotePanel from './vault-note-panel';
import type { SceneNode, VaultGraphScene } from './vault-graph-scene';

// ---------------------------------------------------------------------------
// Types — match the /api/ui/vault/graph contract exactly
// ---------------------------------------------------------------------------
interface VaultNode {
  id: string;
  title: string;
  folder: string;
  tags: string[];
  degree: number;
  mtime: number;
}

interface VaultLink {
  source: string;
  target: string;
}

interface VaultGraphData {
  configured?: boolean;
  nodes: VaultNode[];
  links: VaultLink[];
  stats: { noteCount: number; linkCount: number; generatedAt: number };
}

export interface VaultGraph3DProps {
  onNodeClick?: (node: { id: string; title: string; folder: string }) => void;
  /** Opens the search field overlaid on the graph. Driven by the magnifier in
   *  the widget header, which lives outside this component. */
  rechercheOuverte?: boolean;
  onFermerRecherche?: () => void;
}

// ---------------------------------------------------------------------------
// Orange palette, derived around the hue of the --primary token: the WebGL
// canvas cannot consume Tailwind classes, so the CSS variable is read to stay
// aligned with the TIMON theme without hard-coding a hex.
// ---------------------------------------------------------------------------
const FALLBACK_PRIMARY_HUE = 13;
const FOLDER_HUE_OFFSETS = [0, 6, -6, 12, -10, 18, 3, -3, 22, 9];
const FOLDER_SAT = '72%';

/** The graph follows the app theme. Two palettes, not an inverted colour: the
 *  lightness of a node and of a link do not carry over the same way from one
 *  background to the other.
 *
 *  Nodes: DARKER than the background in light theme, LIGHTER in dark — in
 *  both cases the contrast with the background is what makes them readable.
 *  Links: they must stay behind the nodes without disappearing. On a dark
 *  background a mid grey fades out, hence a clearly lighter grey and a
 *  slightly raised opacity. */
const PALETTES = {
  clair: {
    fond: '#f6f4ef',
    luminositeNoeud: '48%',
    couleurLien: '#5a5a60',
    opaciteLien: 0.13,
  },
  sombre: {
    fond: '#131010',
    luminositeNoeud: '62%',
    couleurLien: '#c9c2b8',
    opaciteLien: 0.16,
  },
} as const;

function readPrimaryHue(): number {
  if (typeof window === 'undefined') return FALLBACK_PRIMARY_HUE;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary');
  const hue = Number.parseFloat(raw.trim().split(/\s+/)[0] ?? '');
  return Number.isFinite(hue) ? hue : FALLBACK_PRIMARY_HUE;
}

function folderColor(folder: string, baseHue: number, luminosite: string): string {
  let hash = 0;
  for (let i = 0; i < folder.length; i++) {
    hash = folder.charCodeAt(i) + ((hash << 5) - hash);
  }
  const offset = FOLDER_HUE_OFFSETS[Math.abs(hash) % FOLDER_HUE_OFFSETS.length]!;
  return `hsl(${baseHue + offset}, ${FOLDER_SAT}, ${luminosite})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NODE_SIZE_MIN = 0.8;
const NODE_SIZE_MAX = 3;
/** `3d-force-graph` treated `nodeVal` as a VOLUME: the apparent radius was
 *  `cbrt(val) * nodeRelSize`, with `nodeRelSize` at 4 by default. The formula
 *  is reproduced so nodes keep exactly their size. */
const NODE_REL_SIZE = 4;
/** The palettes' link opacities (0.13 / 0.16), not 0.28 as in the days of
 *  tubes. Since `LineBasicMaterial.linewidth` is ignored by WebGL on every
 *  platform, a link is now a filament of exactly 1 px. A 0.35-unit tube, on
 *  the other hand, was sub-pixel at the framing distance: antialiasing faded
 *  it to ~half its nominal opacity. At 0.28 the filaments formed a web that
 *  swallowed the nodes. */

/** Steady-state render rate.
 *
 *  This constant was long a decoy: the rAF loop rearmed itself on every frame
 *  and only returned early to avoid DRAWING. The browser therefore produced
 *  120 frames per second no matter what, and lowering it changed nothing
 *  (fixed in df7c09b). It now really drives the number of frames produced.
 *
 *  Why 12 and not 25-30. Instancing made the GRAPH almost free — the renderer
 *  thread drops from 9.6% to 1.5% of a core — but it changes nothing in the
 *  cost each frame imposes on the PAGE. That cost is very real and mostly sits
 *  in the HUD's fourteen `backdrop-filter` surfaces: at 30 fps, neutralising
 *  them brings the total from 23.9% down to 14.4%.
 *
 *  Scale measured in % of a core (gpu-process + renderer, production builds,
 *  45-60 s windows, CPU time read from /proc/<pid>/schedstat). Each rate was
 *  checked against the draw call counter, not assumed:
 *
 *      the original rAF bug, for the record ........... 18.4%
 *      per-object model (2,911 objects), 6 fps ........ 16.4%  ← before
 *      instanced, 6 fps ...............................  6.6%
 *      instanced, 12 fps .............................. 11.6%  ← here
 *      instanced, 30 fps .............................. 23.9%
 *      instanced, 30 fps, blurs neutralised ........... 14.4%
 *
 *  At equal rate, instancing thus divides the cost by 2.5 (16.4 → 6.6).
 *  12 fps doubles the smoothness compared with the old rate while costing a
 *  third less than the bug just fixed. Going higher is paid in page
 *  recompositing, not in graph work: it is an aesthetic trade-off, and it is
 *  tuned on this single line. */
const RENDER_FPS = 12;

/** Delay before the automatic rotation takes over again after a gesture.
 *  3 s was too short: by the time the mouse was released to read a label, the
 *  framing just chosen had already been carried away. */
const IDLE_RESUME_MS = 10000;

function scaleNodeSize(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return NODE_SIZE_MIN;
  const t = degree / maxDegree;
  return NODE_SIZE_MIN + t * (NODE_SIZE_MAX - NODE_SIZE_MIN);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function VaultGraph3D({
  onNodeClick,
  rechercheOuverte = false,
  onFermerRecherche,
}: VaultGraph3DProps) {
  const { open: openSettings } = useSettingsNavigation();
  // Ref callback rather than useRef: the container is unmounted/remounted on
  // every state change (loading → graph), and a ResizeObserver set up once
  // would stay attached to the detached node of the previous state.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [data, setData] = useState<VaultGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  // Awake = tab in the foreground AND widget in the viewport. Nothing justifies
  // drawing when nobody is looking.
  const [eveille, setEveille] = useState(true);

  const sceneRef = useRef<VaultGraphScene | null>(null);
  const [scenePrete, setScenePrete] = useState(0);

  // ---- fetch data ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch('/api/ui/vault/graph')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<VaultGraphData>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('vault.unknownError'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  // ---- sleep: hidden tab or widget off screen -----------------------------
  useEffect(() => {
    const el = container;
    if (!el) return;

    let visibleDansViewport = true;
    const recalculer = () => {
      setEveille(visibleDansViewport && document.visibilityState === 'visible');
    };

    // Two windows side by side are both "visible": the intersection observer
    // catches that case, when the widget has been scrolled out of the
    // viewport by a rail.
    const io = new IntersectionObserver(
      (entries) => {
        visibleDansViewport = entries.some((e) => e.isIntersecting);
        recalculer();
      },
      { threshold: 0.01 },
    );
    io.observe(el);
    document.addEventListener('visibilitychange', recalculer);
    recalculer();

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', recalculer);
    };
  }, [container]);

  // ---- ResizeObserver -----------------------------------------------------
  useEffect(() => {
    const el = container;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDimensions({ width, height });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [container]);

  const maxDegree = useMemo(
    () => data?.nodes.reduce((m, n) => Math.max(m, n.degree), 0) ?? 0,
    [data],
  );

  // Built ONCE per data set, and reused as is at every scene construction. The
  // simulation writes x/y/z into these objects: keeping them keeps the layout.
  // Without that, switching to full screen — which moves the component in the
  // React tree, hence remounts it — would replay two seconds of settling on
  // every round trip.
  const grapheScene = useMemo(() => {
    if (!data) return null;
    return {
      nodes: data.nodes.map((n) => ({
        id: n.id, title: n.title, folder: n.folder, degree: n.degree,
      })),
      links: data.links.map((l) => ({ source: l.source, target: l.target })),
    };
  }, [data]);

  // The hue comes from the CSS token: readable only after mount, hence the
  // state. It is read again on every theme switch, since the token may change
  // with it.
  const { scheme: resolvedTheme } = useColorScheme();
  const palette = resolvedTheme === 'dark' ? PALETTES.sombre : PALETTES.clair;
  const [primaryHue, setPrimaryHue] = useState(FALLBACK_PRIMARY_HUE);
  useEffect(() => {
    const sync = () => setPrimaryHue(readPrimaryHue());
    sync();
    window.addEventListener('timon:theme-painted', sync);
    return () => window.removeEventListener('timon:theme-painted', sync);
  }, [resolvedTheme]);

  const couleurNoeud = useCallback(
    (n: { folder: string }) => folderColor(n.folder, primaryHue, palette.luminositeNoeud),
    [primaryHue, palette],
  );

  // ---- automatic rotation, paused during gestures --------------------------
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suspendreRotation = useCallback(() => {
    sceneRef.current?.definirRotation(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      sceneRef.current?.definirRotation(true);
    }, IDLE_RESUME_MS);
  }, []);

  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  // ---- mounting the three.js scene ----------------------------------------
  // `await import()` in an effect rather than `next/dynamic`: the module pulls
  // in three.js and must never be evaluated during prerendering. An effect
  // only runs on the client, so the barrier is structural, not declarative.
  const hote = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = hote.current;
    if (!el || loading || error || !grapheScene || grapheScene.nodes.length === 0) return;

    let annule = false;
    let scene: VaultGraphScene | null = null;

    void (async () => {
      const { VaultGraphScene: Scene } = await import('./vault-graph-scene');
      if (annule) return;

      scene = new Scene({
        container: el,
        width: dimensions.width,
        height: dimensions.height,
        // The simulation MUTATES these objects (x/y/z, fx/fy/fz): they are
        // copies of the React data, memoised to survive remounts.
        nodes: grapheScene.nodes,
        links: grapheScene.links,
        nodeColor: couleurNoeud,
        nodeRadius: (n) => Math.cbrt(scaleNodeSize(n.degree, maxDegree)) * NODE_REL_SIZE,
        linkColor: palette.couleurLien,
        linkOpacity: palette.opaciteLien,
        cadenceBase: RENDER_FPS,
        onClick: (n: SceneNode) => {
          setOpenNoteId(n.id);
          onNodeClick?.({ id: n.id, title: n.title, folder: n.folder });
        },
        onInteract: suspendreRotation,
      });

      sceneRef.current = scene;
      // Wakes the render loop, which waits for the scene to exist.
      setScenePrete((n) => n + 1);
    })();

    return () => {
      annule = true;
      scene?.detruire();
      if (sceneRef.current === scene) sceneRef.current = null;
    };
    // `dimensions` is deliberately missing: a resize goes through
    // `redimensionner()`, it must not rebuild the whole scene (which would
    // restart the simulation and make the framing jump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grapheScene, loading, error, maxDegree, onNodeClick, suspendreRotation]);

  // The theme applies to the scene in place: rebuilding it for a mere
  // light/dark switch would replay the layout for nothing.
  useEffect(() => {
    sceneRef.current?.definirTheme({
      nodeColor: couleurNoeud,
      linkColor: palette.couleurLien,
      linkOpacity: palette.opaciteLien,
    });
  }, [couleurNoeud, palette, scenePrete]);

  // The resize is applied to the existing scene.
  useEffect(() => {
    sceneRef.current?.redimensionner(dimensions.width, dimensions.height);
  }, [dimensions, scenePrete]);

  // ---- render loop --------------------------------------------------------
  // The timer PACES, the rAF DRAWS. The rAF is never rearmed from its own
  // callback: a permanently registered rAF callback forces the browser to run
  // the whole frame pipeline on every vsync — 120 frames per second on a still
  // page — even if it draws nothing. That was the leak fixed in df7c09b.
  //
  // Going through a rAF rather than drawing directly in the timer keeps two
  // properties: drawing stays aligned with vsync, and the browser does not call
  // the callback back when nothing is composited — so nothing spins idle with
  // the window minimised, which `eveille` alone does not guarantee
  // (`visibilitychange` is not emitted by every window manager).
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !eveille) return;

    let arrete = false;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const planifier = () => {
      if (arrete) return;
      // While settling and during a drag the scene really moves: draw at full
      // speed, it is transient. Otherwise fall back to the cruising rate.
      const delai = scene.enMouvement ? 0 : 1000 / scene.cadenceSouhaitee;
      timer = setTimeout(() => {
        raf = requestAnimationFrame(() => {
          raf = 0;
          scene.rendre();
          planifier();
        });
      }, delai);
    };

    planifier();

    return () => {
      arrete = true;
      if (timer) clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [eveille, scenePrete]);

  // ---- search -------------------------------------------------------------
  // The filter covers the title, path, folder and tags — everything the graph
  // payload already holds. Note BODIES are not covered: that would need a
  // search endpoint on the orchestrator side, hence a restart of it, which is
  // a separate ops step.
  const [requete, setRequete] = useState('');
  const champRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (rechercheOuverte) champRef.current?.focus();
    // Closing the search must lift the filter, otherwise nodes would stay
    // hidden with nothing on screen explaining why.
    else setRequete('');
  }, [rechercheOuverte]);

  const correspondants = useMemo(() => {
    const q = requete.trim().toLowerCase();
    if (!q || !data) return null;
    const ids = new Set<string>();
    for (const n of data.nodes) {
      const foin = `${n.title} ${n.id} ${n.folder} ${(n.tags ?? []).join(' ')}`.toLowerCase();
      if (foin.includes(q)) ids.add(n.id);
    }
    return ids;
  }, [requete, data]);

  useEffect(() => {
    sceneRef.current?.definirFiltre(correspondants);
  }, [correspondants, scenePrete]);

  // Wikilinks carry a basename (`[[cockpit-hud]]`), nodes a full path
  // (`wiki/projects/timon/cockpit-hud`): the id is found through the last
  // segment, preferring an exact path when there is one.
  const followLink = useCallback(
    (target: string) => {
      const nodes = data?.nodes ?? [];
      const exact = nodes.find((n) => n.id === target);
      if (exact) { setOpenNoteId(exact.id); return; }
      const bn = target.split('/').pop();
      const match = nodes.find((n) => n.id.split('/').pop() === bn);
      if (match) setOpenNoteId(match.id);
    },
    [data],
  );

  // ---- render states ------------------------------------------------------
  if (loading) {
    return (
      <div
        ref={setContainer}
        className="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
      >
        {t('vault.loadingGraph')}
      </div>
    );
  }

  if (error) {
    return (
      <div
        ref={setContainer}
        className="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
      >
        {t('vault.graphUnavailable', { error })}
      </div>
    );
  }

  if (!data || data.nodes.length === 0) {
    return (
      <div
        ref={setContainer}
        className="flex h-full w-full items-center justify-center text-xs text-muted-foreground"
      >
        {data?.configured === false ? <a
          href="/settings?group=misc"
          className="underline"
          onClick={(e) => { e.preventDefault(); openSettings({ category: 'memory', tab: 'obsidian' }); }}
        >{t('vaultNotConfigured')}</a> : t('vault.noNodes')}
      </div>
    );
  }

  // ---- main render --------------------------------------------------------
  return (
    <div ref={setContainer} className="relative h-full w-full overflow-hidden">
      {/* The graph background follows the app theme. It stays a gradient of the
          widget's own rather than a token colour: the central halo sets the
          node cluster apart from the panel edge, in both themes. */}
      <div aria-hidden className="absolute inset-0 z-0" style={{ background: palette.fond }} />
      {/* Host of the WebGL canvas, mounted and emptied by the scene itself. */}
      <div ref={hote} className="absolute inset-0 z-10" />

      {/* Search as an overlay rather than a bar above: the panel is already
          small, taking 32 px of height from it would make it unreadable. */}
      {rechercheOuverte && (
        <div className="absolute inset-x-2 top-2 z-20 flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/90 px-2 py-1 backdrop-blur-sm">
          <input
            ref={champRef}
            value={requete}
            onChange={(e) => setRequete(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onFermerRecherche?.(); }}
            placeholder={t('vault.filter')}
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/70">
            {correspondants ? `${correspondants.size}/${data.nodes.length}` : data.nodes.length}
          </span>
          <button
            type="button"
            onClick={() => onFermerRecherche?.()}
            aria-label={t('vault.closeSearch')}
            className="shrink-0 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {openNoteId && (
        <VaultNotePanel
          noteId={openNoteId}
          onClose={() => setOpenNoteId(null)}
          onFollowLink={followLink}
        />
      )}
    </div>
  );
}
