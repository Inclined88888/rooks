/**
 * Physical order and visibility of the chat columns.
 *
 * Until now, "left" and "right" were not data: the `chat.left.widget` zone was
 * glued to a hard-coded `left-…` and the `chat.right.widget` zone to a
 * `right-…`, so swapping the two sidebars meant editing the page CSS. This
 * module makes the order a layout property (a list of zones, from leftmost to
 * rightmost) and collapsing a property of the collapsed column, not of the
 * missions rail alone.
 *
 * Pure model: it reads and writes nothing. Persistence goes through the
 * existing `loadLayout` / `saveLayout`, on their own `scope` (§10.12, part 6):
 * card placement and column order are two values with different lives (the
 * first changes at every drag, the second almost never), and mixing them would
 * force two shapes to live in the same opaque JSON, hence a migration for
 * nothing.
 */

import type { LayoutIo } from '@/lib/ui-layout-store';

export type ChatColumns = {
  /** Zones, from leftmost to rightmost. */
  ordre: string[];
  /** Zones the user collapsed. A collapsed zone keeps its place. */
  masquees: string[];
  /**
   * A column's tabs beyond the first, by column zone. The first tab IS the
   * column's zone: placements written before tabs existed stay there with no
   * migration. Absent = a single tab, so the stored value of a user who never
   * opens one does not change by a byte.
   */
  onglets?: Record<string, string[]>;
  /** Tab shown by a column, when it is not the first. */
  actifs?: Record<string, string>;
  /**
   * Width chosen by the user, in px, by shown zone (a column, or the tab shown
   * as its second column). Absent = the default width of its side.
   */
  largeurs?: Record<string, number>;
  /**
   * The tab a column shows BESIDE itself, by column zone. A second column is a
   * tab, not a zone of its own: when the screen is too narrow it folds back
   * into the tab bar, cards and placement included, with nothing to migrate.
   */
  secondes?: Record<string, string>;
  /**
   * Label the user (or an applied proposal) gave a tab, by zone. Absent = the
   * tab shows no text, as before names existed.
   */
  noms?: Record<string, string>;
  /**
   * Width of the thread's reading column chosen by the user, in px (text
   * only, gutters excluded). Absent = it follows the room the chat has.
   */
  fil?: number;
};

/** Narrowest reading column the user can drag the thread to. */
export const FIL_LECTURE_MIN = 420;
/** Widest one, whatever the screen: past it a line no longer reads. */
export const FIL_LECTURE_MAX = 2400;

export function bornerFil(largeur: number): number {
  return Math.round(Math.min(FIL_LECTURE_MAX, Math.max(FIL_LECTURE_MIN, largeur)));
}

/** Sets the reading column's width, clamped; `null` goes back to the room the chat has. */
export function poserFil(c: ChatColumns, largeur: number | null): ChatColumns {
  return avec(c, { fil: largeur === null || !Number.isFinite(largeur) ? undefined : bornerFil(largeur) });
}

/** Longest tab name: a tab is a narrow pill. */
export const NOM_ONGLET_MAX = 40;

/** Trimmed, inner spaces folded, capped; empty = no name. */
function lireNom(brut: unknown): string | null {
  if (typeof brut !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const nom = brut.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, NOM_ONGLET_MAX);
  return nom || null;
}

/** Physical side of a column: what the page chrome makes of it. */
export type CoteColonne = 'left' | 'right';

/** The `ui_layout` scope where the column order is persisted. */
export const CHAT_COLUMNS_SCOPE = 'chat.columns';

/**
 * The `ui_layout` accessors for the columns.
 *
 * `storage: null` turns off picking up the layout left in `localStorage`: it
 * only knows one key, the cockpit's, and would write it here as a column
 * order; a card placement would become the column positions.
 */
export function ioColonnes(io: LayoutIo = {}): LayoutIo {
  return { ...io, scope: CHAT_COLUMNS_SCOPE, storage: null };
}

/** Original order: the zones in the order the caller declares them. */
export function colonnesDefaut(connues: readonly string[]): ChatColumns {
  return { ordre: [...connues], masquees: [] };
}

/**
 * Separator between a column's zone and the suffix of its tabs.
 *
 * A tab is a widget zone in its own right (`chat.right.widget#k3x`), governed
 * by its column's slot: that is what lets the host place, drag and persist its
 * cards without knowing tabs exist.
 */
const SEPARATEUR_ONGLET = '#';

/** Zone of the column a tab belongs to — itself for the first tab. */
export function zoneDeColonne(zone: string): string {
  const i = zone.indexOf(SEPARATEUR_ONGLET);
  return i < 0 ? zone : zone.slice(0, i);
}

function estOngletDe(zone: string, colonne: string): boolean {
  return zone.startsWith(colonne + SEPARATEUR_ONGLET) && zone.length > colonne.length + 1;
}

/**
 * Copies, emitting tabs only when there are some: a column back to a single
 * tab regains exactly the shape it had before tabs existed.
 */
function avec(
  c: ChatColumns,
  patch: Partial<ChatColumns>,
): ChatColumns {
  const suite = { ...c, ...patch };
  const onglets: Record<string, string[]> = {};
  for (const [colonne, liste] of Object.entries(suite.onglets ?? {})) {
    if (liste.length > 0) onglets[colonne] = [...liste];
  }
  const actifs: Record<string, string> = {};
  for (const [colonne, zone] of Object.entries(suite.actifs ?? {})) {
    if (onglets[colonne]?.includes(zone)) actifs[colonne] = zone;
  }
  const secondes: Record<string, string> = {};
  for (const [colonne, zone] of Object.entries(suite.secondes ?? {})) {
    if (onglets[colonne]?.includes(zone)) secondes[colonne] = zone;
  }
  // A width outlives nothing it measured: a closed tab takes its own along.
  const zones = new Set(suite.ordre.flatMap((colonne) => [colonne, ...(onglets[colonne] ?? [])]));
  const largeurs: Record<string, number> = {};
  for (const [zone, largeur] of Object.entries(suite.largeurs ?? {})) {
    if (zones.has(zone) && typeof largeur === 'number' && Number.isFinite(largeur)) {
      largeurs[zone] = bornerLargeur(largeur);
    }
  }
  // A name, like a width, leaves with its tab.
  const noms: Record<string, string> = {};
  for (const [zone, brut] of Object.entries(suite.noms ?? {})) {
    const nom = lireNom(brut);
    if (zones.has(zone) && nom) noms[zone] = nom;
  }
  const out: ChatColumns = { ordre: [...suite.ordre], masquees: [...suite.masquees] };
  if (Object.keys(onglets).length > 0) out.onglets = onglets;
  if (Object.keys(actifs).length > 0) out.actifs = actifs;
  if (Object.keys(largeurs).length > 0) out.largeurs = largeurs;
  if (Object.keys(secondes).length > 0) out.secondes = secondes;
  if (Object.keys(noms).length > 0) out.noms = noms;
  if (typeof suite.fil === 'number' && Number.isFinite(suite.fil)) out.fil = bornerFil(suite.fil);
  return out;
}

function listeDeChaines(brut: unknown): string[] {
  return Array.isArray(brut) ? brut.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Reads the stored value back, checking it against the zones the page mounts.
 *
 * Tolerant by construction, like `fusionnerLayout`: an unknown zone is ignored
 * (rename, missing plugin), a known zone missing from storage is added at its
 * original place, and a duplicate counts once. An unreadable value is thus
 * never a broken page, only a return to the defaults.
 */
export function lireColonnes(brut: unknown, connues: readonly string[]): ChatColumns {
  const o = typeof brut === 'object' && brut !== null ? (brut as Record<string, unknown>) : {};
  const admises = new Set(connues);
  const vues = new Set<string>();

  const ordre: string[] = [];
  for (const zone of listeDeChaines(o.ordre)) {
    if (!admises.has(zone) || vues.has(zone)) continue;
    vues.add(zone);
    ordre.push(zone);
  }
  for (const zone of connues) if (!vues.has(zone)) ordre.push(zone);

  const masquees = [...new Set(listeDeChaines(o.masquees).filter((z) => admises.has(z)))];

  // A tab is only admitted under its own column: an id naming the other
  // column would show its cards in two places.
  const ongletsBruts = typeof o.onglets === 'object' && o.onglets !== null
    ? (o.onglets as Record<string, unknown>) : {};
  const onglets: Record<string, string[]> = {};
  for (const colonne of connues) {
    onglets[colonne] = [...new Set(listeDeChaines(ongletsBruts[colonne]).filter((z) => estOngletDe(z, colonne)))];
  }
  const actifsBruts = typeof o.actifs === 'object' && o.actifs !== null
    ? (o.actifs as Record<string, unknown>) : {};
  const actifs: Record<string, string> = {};
  for (const colonne of connues) {
    const zone = actifsBruts[colonne];
    if (typeof zone === 'string') actifs[colonne] = zone;
  }
  const secondesBruts = typeof o.secondes === 'object' && o.secondes !== null
    ? (o.secondes as Record<string, unknown>) : {};
  const secondes: Record<string, string> = {};
  for (const colonne of connues) {
    const zone = secondesBruts[colonne];
    if (typeof zone === 'string') secondes[colonne] = zone;
  }
  const largeursBruts = typeof o.largeurs === 'object' && o.largeurs !== null
    ? (o.largeurs as Record<string, unknown>) : {};
  const largeurs: Record<string, number> = {};
  for (const [zone, largeur] of Object.entries(largeursBruts)) {
    if (typeof largeur === 'number') largeurs[zone] = largeur;
  }
  const nomsBruts = typeof o.noms === 'object' && o.noms !== null
    ? (o.noms as Record<string, unknown>) : {};
  const noms: Record<string, string> = {};
  for (const [zone, brut] of Object.entries(nomsBruts)) {
    const nom = lireNom(brut);
    if (nom) noms[zone] = nom;
  }
  return avec({ ordre, masquees }, { onglets, actifs, secondes, largeurs, noms, ...(typeof o.fil === 'number' ? { fil: o.fil } : {}) });
}

/** Names a tab (the first included); `null` or an empty name removes it. */
export function nommerOnglet(c: ChatColumns, zone: string, nom: string | null): ChatColumns {
  const noms = { ...c.noms };
  const propre = lireNom(nom);
  if (propre) noms[zone] = propre;
  else delete noms[zone];
  return avec(c, { noms });
}

/**
 * Reverses the physical order of the columns.
 *
 * Collapsing follows the ZONE, not the side: a column collapsed then swapped
 * stays collapsed. It is the card that was put away, not half of the screen.
 */
export function inverserColonnes(c: ChatColumns): ChatColumns {
  return avec(c, { ordre: [...c.ordre].reverse() });
}

export function estMasquee(c: ChatColumns, zone: string): boolean {
  return c.masquees.includes(zone);
}

/** Collapses an expanded column, expands a collapsed one. */
export function basculerMasquee(c: ChatColumns, zone: string): ChatColumns {
  return poserMasquee(c, zone, !estMasquee(c, zone));
}

/**
 * `zone` folded or unfolded, whatever the columns say now: a click once
 * decided. Replayed over another window's write (TODO #647), a toggle would
 * undo the very click it stands for.
 */
export function poserMasquee(c: ChatColumns, zone: string, masquee: boolean): ChatColumns {
  const autres = c.masquees.filter((z) => z !== zone);
  if (masquee === estMasquee(c, zone)) return c;
  return avec(c, { masquees: masquee ? [...autres, zone] : autres });
}

/**
 * Side of a column, derived from its rank. The chat has two: the first is on
 * the left, everything else on the right, and `null` for a zone that is not a
 * column, for which the chrome must reserve nothing.
 */
export function coteDe(c: ChatColumns, zone: string): CoteColonne | null {
  const i = c.ordre.indexOf(zone);
  if (i < 0) return null;
  return i === 0 ? 'left' : 'right';
}

/** Zone holding a side, or `null` if the order does not count that many. */
export function zoneDuCote(c: ChatColumns, cote: CoteColonne): string | null {
  return (cote === 'left' ? c.ordre[0] : c.ordre[1]) ?? null;
}

/** A column's tabs, in order: its own zone first. */
export function ongletsDe(c: ChatColumns, colonne: string): string[] {
  return [colonne, ...(c.onglets?.[colonne] ?? [])];
}

/** Zone a column shows: the chosen tab, otherwise the first. */
export function ongletActif(c: ChatColumns, colonne: string): string {
  const choisi = c.actifs?.[colonne];
  return choisi && ongletsDe(c, colonne).includes(choisi) ? choisi : colonne;
}

/**
 * Opens a tab at the end of the column and shows it.
 *
 * The suffix comes from the caller and must never be reused: a closed tab can
 * leave behind the placement of an absent plugin, which the host keeps as is.
 * A new tab taking over its id would bring that card back inside it when the
 * plugin returns.
 */
export function ajouterOnglet(c: ChatColumns, colonne: string, suffixe: string): ChatColumns {
  const zone = `${colonne}${SEPARATEUR_ONGLET}${suffixe}`;
  if (!c.ordre.includes(colonne) || !estOngletDe(zone, colonne) || ongletsDe(c, colonne).includes(zone)) return avec(c, {});
  return avec(c, {
    onglets: { ...c.onglets, [colonne]: [...(c.onglets?.[colonne] ?? []), zone] },
    actifs: { ...c.actifs, [colonne]: zone },
  });
}

/** Shows a tab of the column. A zone that is not one of its tabs changes nothing. */
export function choisirOnglet(c: ChatColumns, colonne: string, zone: string): ChatColumns {
  if (!ongletsDe(c, colonne).includes(zone)) return avec(c, {});
  const actifs = { ...c.actifs };
  if (zone === colonne) delete actifs[colonne];
  else actifs[colonne] = zone;
  return avec(c, { actifs });
}

/**
 * Closes a tab. The first one cannot be closed: it is the column. Closing the
 * shown tab shows the one before it.
 *
 * What the tab held is not this model's business: the caller pours its cards
 * into the first tab before closing it.
 */
export function retirerOnglet(c: ChatColumns, colonne: string, zone: string): ChatColumns {
  const liste = c.onglets?.[colonne] ?? [];
  const i = liste.indexOf(zone);
  if (i < 0) return avec(c, {});
  const reste = liste.filter((z) => z !== zone);
  const actifs = { ...c.actifs };
  if (ongletActif(c, colonne) === zone) {
    const precedent = i > 0 ? liste[i - 1]! : colonne;
    if (precedent === colonne) delete actifs[colonne];
    else actifs[colonne] = precedent;
  }
  return avec(c, { onglets: { ...c.onglets, [colonne]: reste }, actifs });
}

/** Narrowest a column gets: below this, the cards stop reading. */
export const LARGEUR_MIN = 240;
/** Widest a column gets, whatever the screen. */
export const LARGEUR_MAX = 800;
/** Default width of a second column. */
export const LARGEUR_SECONDE = 300;

export function bornerLargeur(largeur: number): number {
  return Math.round(Math.min(LARGEUR_MAX, Math.max(LARGEUR_MIN, largeur)));
}

/**
 * Where a column and its mirror land for a gesture that asks `voulue` for the
 * column. Both move by the same amount, held by whichever bound comes first:
 * the room left is shared by two columns growing at once.
 */
export function largeursJumelees(
  depart: number, voulue: number, max: number, jumelle: { largeur: number; max: number },
): { largeur: number; jumelle: number } {
  const min = Math.min(LARGEUR_MIN, max);
  const hausseMax = Math.max(0, Math.min((max - depart) / 2, jumelle.max - jumelle.largeur));
  const baisseMax = Math.max(0, Math.min(depart - min, jumelle.largeur - Math.min(LARGEUR_MIN, jumelle.max)));
  const delta = Math.max(-baisseMax, Math.min(hausseMax, voulue - depart));
  return { largeur: Math.round(depart + delta), jumelle: Math.round(jumelle.largeur + delta) };
}

/** Width chosen for a shown zone, otherwise the default of its place. */
export function largeurDe(c: ChatColumns, zone: string, defaut: number): number {
  return c.largeurs?.[zone] ?? defaut;
}

/**
 * Sets the width of a shown zone, clamped. `null` goes back to the default:
 * the entry is dropped rather than written with the default value, so that a
 * default that changes later still applies.
 */
export function poserLargeur(c: ChatColumns, zone: string, largeur: number | null): ChatColumns {
  const largeurs = { ...c.largeurs };
  if (largeur === null || !Number.isFinite(largeur)) delete largeurs[zone];
  else largeurs[zone] = bornerLargeur(largeur);
  return avec(c, { largeurs });
}

/** The tab a column shows beside itself, if any. */
export function secondeDe(c: ChatColumns, colonne: string): string | null {
  const zone = c.secondes?.[colonne];
  return zone && ongletsDe(c, colonne).includes(zone) ? zone : null;
}

/**
 * Opens a second column beside a column: a new tab, shown beside it rather
 * than in its place. The tab shown in the column does not change. A column has
 * at most one second column; asking again changes nothing.
 *
 * Same rule for the suffix as `ajouterOnglet`: never reused.
 */
export function ajouterSeconde(c: ChatColumns, colonne: string, suffixe: string): ChatColumns {
  if (secondeDe(c, colonne) !== null) return avec(c, {});
  const zone = `${colonne}${SEPARATEUR_ONGLET}${suffixe}`;
  const ouvert = ajouterOnglet(c, colonne, suffixe);
  if (!ongletsDe(ouvert, colonne).includes(zone)) return ouvert;
  return avec(ouvert, {
    actifs: c.actifs,
    secondes: { ...c.secondes, [colonne]: zone },
  });
}

/**
 * Puts a second column back among the column's tabs. Nothing is lost: the tab
 * keeps its cards and stays reachable from the tab bar.
 */
export function detacherSeconde(c: ChatColumns, colonne: string): ChatColumns {
  const secondes = { ...c.secondes };
  delete secondes[colonne];
  return avec(c, { secondes });
}

/** Room the thread keeps, whatever the columns ask for. */
export const FIL_MIN = 480;
/** Gap between a column and the screen edge, or the thread on the left. */
const BORD = 16;
/** Gap between two columns of a side, and between the column and the thread on the right. */
const ECART = 12;

/** What a side asks for, before the screen has its say. */
export type DemandeCote = {
  /** Width of the column itself. */
  largeur: number;
  /** Whether the column itself is shown (it may be empty outside a drag). */
  premiere: boolean;
  /** Width of its second column, or `null` when none is shown. */
  seconde: number | null;
};

/** What a side gets: widths actually painted, `null` for a column not shown. */
export type PlaceCote = {
  premiere: number | null;
  seconde: number | null;
  /** The second column was asked for but folded back into the tabs. */
  secondeRepliee: boolean;
  /** Distance of the second column from the screen edge, in px. */
  decalageSeconde: number;
  /** Width the thread reserves for this side, in px (nav excluded). */
  gouttiere: number;
};

export type PlanRails = {
  gauche: PlaceCote | null;
  droite: PlaceCote | null;
  /** Room still free beyond the thread's minimum, in px. */
  marge: number;
};

function largeursDe(p: Pick<PlaceCote, 'premiere' | 'seconde'>): number[] {
  return [p.premiere, p.seconde].filter((w): w is number => w !== null);
}

function gouttiereDe(cote: CoteColonne, largeurs: number[]): number {
  if (largeurs.length === 0) return 0;
  const somme = largeurs.reduce((a, b) => a + b, 0) + ECART * (largeurs.length - 1);
  // Left: the figures the fixed classes used to carry (280 → 312, 300 → 332).
  // Right: the thread's scroll zone sits above the columns (`z-10`), so the
  // gutter must clear the width handle past the column's edge — the old 312
  // let the thread overlap the column by 4px; it is 328 now.
  return cote === 'left' ? BORD + somme + BORD : BORD + somme + ECART;
}

function placer(cote: CoteColonne, p: Pick<PlaceCote, 'premiere' | 'seconde' | 'secondeRepliee'>): PlaceCote {
  return {
    ...p,
    decalageSeconde: p.premiere === null ? 0 : p.premiere + ECART,
    gouttiere: gouttiereDe(cote, largeursDe(p)),
  };
}

/**
 * Lays the columns out on the width the chat has.
 *
 * The thread keeps `FIL_MIN`. When the columns ask for more, the second
 * columns fold back into their tabs first — the widest side first — then the
 * widths shrink in proportion, never below `LARGEUR_MIN`. `disponible <= 0`
 * means not measured yet: everything is shown as asked.
 */
export function planifierRails(
  disponible: number,
  gauche: DemandeCote | null,
  droite: DemandeCote | null,
): PlanRails {
  const cotes: Array<[CoteColonne, DemandeCote | null]> = [['left', gauche], ['right', droite]];
  const places = new Map<CoteColonne, PlaceCote>();
  for (const [cote, d] of cotes) {
    if (d) places.set(cote, placer(cote, {
      premiere: d.premiere || d.seconde === null ? d.largeur : null,
      seconde: d.seconde,
      secondeRepliee: false,
    }));
  }
  const occupe = () => [...places.values()].reduce((a, p) => a + p.gouttiere, 0);
  const libre = () => disponible - FIL_MIN - occupe();
  const mesure = disponible > 0;

  while (mesure && libre() < 0) {
    const avecSeconde = [...places.entries()]
      .filter(([, p]) => p.seconde !== null)
      .sort(([, a], [, b]) => b.gouttiere - a.gouttiere);
    const premier = avecSeconde[0];
    if (!premier) break;
    const [cote] = premier;
    const d = cote === 'left' ? gauche! : droite!;
    places.set(cote, placer(cote, { premiere: d.largeur, seconde: null, secondeRepliee: true }));
  }

  if (mesure && libre() < 0) {
    const toutes = [...places.values()].flatMap(largeursDe);
    const somme = toutes.reduce((a, b) => a + b, 0);
    const facteur = somme > 0 ? Math.max(0, (somme + libre()) / somme) : 1;
    const reduire = (w: number | null) => w === null ? null : Math.max(LARGEUR_MIN, Math.floor(w * facteur));
    for (const [cote, p] of places) {
      places.set(cote, placer(cote, { ...p, premiere: reduire(p.premiere), seconde: reduire(p.seconde) }));
    }
  }

  return {
    gauche: places.get('left') ?? null,
    droite: places.get('right') ?? null,
    marge: mesure ? Math.max(0, libre()) : Number.POSITIVE_INFINITY,
  };
}

/** Below this width the columns stop floating beside the thread: each one
 *  becomes a panel of the chat's island, opened on demand. The same breakpoint
 *  as `lg`, which used to hide them outright. */
export const SEUIL_TIROIR = 1024;

/**
 * Whether the chat, `largeur` px wide (nav included), shows its columns as
 * panels. Unmeasured (0) is not narrow: the first paint keeps the floating
 * columns, which CSS hides on a small screen until the measure lands.
 */
export function estEnTiroir(largeur: number): boolean {
  return largeur > 0 && largeur < SEUIL_TIROIR;
}
