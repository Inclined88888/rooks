import assert from 'node:assert/strict';
import test from 'node:test';

import { LEGACY_LAYOUT_KEY, loadLayout, saveLayout } from './ui-layout-store';
import {
  ajouterOnglet,
  basculerMasquee,
  poserMasquee,
  choisirOnglet,
  ongletActif,
  ongletsDe,
  retirerOnglet,
  zoneDeColonne,
  colonnesDefaut,
  coteDe,
  estMasquee,
  inverserColonnes,
  ioColonnes,
  lireColonnes,
  zoneDuCote,
  CHAT_COLUMNS_SCOPE,
  ajouterSeconde,
  detacherSeconde,
  largeurDe,
  planifierRails,
  poserLargeur,
  secondeDe,
  FIL_MIN,
  LARGEUR_MAX,
  LARGEUR_MIN,
  type ChatColumns,
} from '../components/chat/chat-columns';

const GAUCHE = 'chat.left.widget';
const DROITE = 'chat.right.widget';
const CONNUES = [GAUCHE, DROITE] as const;

test('rien de stocké : les colonnes sont dans leur ordre déclaré', () => {
  const c = lireColonnes(null, CONNUES);
  assert.deepEqual(c, { ordre: [GAUCHE, DROITE], masquees: [] });
  assert.deepEqual(c, colonnesDefaut(CONNUES));
});

test('inverser change le côté des deux colonnes', () => {
  const c = inverserColonnes(colonnesDefaut(CONNUES));
  assert.equal(coteDe(c, GAUCHE), 'right');
  assert.equal(coteDe(c, DROITE), 'left');
  assert.equal(zoneDuCote(c, 'left'), DROITE);
  assert.equal(zoneDuCote(c, 'right'), GAUCHE);
});

test('inverser deux fois revient à l’ordre d’origine', () => {
  const c = colonnesDefaut(CONNUES);
  assert.deepEqual(inverserColonnes(inverserColonnes(c)), c);
});

test('le repli suit la zone, pas le côté : inverser ne déplie rien', () => {
  const replie = basculerMasquee(colonnesDefaut(CONNUES), GAUCHE);
  const inverse = inverserColonnes(replie);
  assert.equal(estMasquee(inverse, GAUCHE), true);
  assert.equal(estMasquee(inverse, DROITE), false);
  // La colonne repliée est maintenant celle de droite.
  assert.equal(coteDe(inverse, GAUCHE), 'right');
});

test('masquer puis démasquer rend l’état d’origine', () => {
  const c = colonnesDefaut(CONNUES);
  assert.deepEqual(basculerMasquee(basculerMasquee(c, DROITE), DROITE), c);
});

test('une colonne repliée garde sa place dans l’ordre', () => {
  const c = basculerMasquee(colonnesDefaut(CONNUES), GAUCHE);
  assert.deepEqual(c.ordre, [GAUCHE, DROITE]);
});

test('un ordre inversé se relit tel quel', () => {
  const stocke = inverserColonnes(basculerMasquee(colonnesDefaut(CONNUES), DROITE));
  const relu = lireColonnes(JSON.parse(JSON.stringify(stocke)), CONNUES);
  assert.deepEqual(relu, stocke);
});

test('une zone inconnue du stockage est ignorée', () => {
  const c = lireColonnes({ ordre: ['chat.disparue', DROITE], masquees: ['chat.disparue'] }, CONNUES);
  assert.deepEqual(c.ordre, [DROITE, GAUCHE]);
  assert.deepEqual(c.masquees, []);
});

test('une zone connue absente du stockage revient à sa place déclarée', () => {
  const c = lireColonnes({ ordre: [DROITE] }, CONNUES);
  assert.deepEqual(c.ordre, [DROITE, GAUCHE]);
});

test('un doublon de stockage ne compte qu’une fois', () => {
  const c = lireColonnes({ ordre: [DROITE, DROITE, GAUCHE], masquees: [GAUCHE, GAUCHE] }, CONNUES);
  assert.deepEqual(c.ordre, [DROITE, GAUCHE]);
  assert.deepEqual(c.masquees, [GAUCHE]);
});

test('une valeur illisible retombe sur les défauts au lieu de casser', () => {
  for (const brut of [undefined, 42, 'nope', [], { ordre: 'gauche', masquees: 7 }]) {
    assert.deepEqual(lireColonnes(brut, CONNUES), colonnesDefaut(CONNUES));
  }
});

test('une zone hors colonnes n’a pas de côté : le chrome ne réserve rien', () => {
  assert.equal(coteDe(colonnesDefaut(CONNUES), 'cockpit.widget'), null);
});

test('les mutations ne modifient pas la valeur reçue', () => {
  const c: ChatColumns = colonnesDefaut(CONNUES);
  const copie = JSON.parse(JSON.stringify(c)) as ChatColumns;
  inverserColonnes(c);
  basculerMasquee(c, GAUCHE);
  assert.deepEqual(c, copie);
});

test('une seule colonne déclarée : elle est à gauche, rien à droite', () => {
  const c = colonnesDefaut([GAUCHE]);
  assert.equal(coteDe(c, GAUCHE), 'left');
  assert.equal(zoneDuCote(c, 'right'), null);
});

// ── Onglets : une colonne alterne entre plusieurs zones de widgets.

test('sans onglet, une colonne affiche sa propre zone', () => {
  const c = colonnesDefaut(CONNUES);
  assert.deepEqual(ongletsDe(c, DROITE), [DROITE]);
  assert.equal(ongletActif(c, DROITE), DROITE);
});

test('ouvrir un onglet l’affiche, sous la colonne qui l’a ouvert', () => {
  const c = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  assert.deepEqual(ongletsDe(c, DROITE), [DROITE, `${DROITE}#a`]);
  assert.equal(ongletActif(c, DROITE), `${DROITE}#a`);
  assert.deepEqual(ongletsDe(c, GAUCHE), [GAUCHE]);
  assert.equal(zoneDeColonne(`${DROITE}#a`), DROITE);
  assert.equal(zoneDeColonne(DROITE), DROITE);
});

test('un suffixe déjà pris, vide ou une colonne inconnue ne créent rien', () => {
  const c = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  assert.deepEqual(ajouterOnglet(c, DROITE, 'a'), c);
  assert.deepEqual(ajouterOnglet(c, DROITE, ''), c);
  assert.deepEqual(ajouterOnglet(c, 'chat.ailleurs', 'b'), c);
});

test('choisir un onglet le montre, revenir au premier efface le choix', () => {
  const ouvert = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  const premier = choisirOnglet(ouvert, DROITE, DROITE);
  assert.equal(ongletActif(premier, DROITE), DROITE);
  assert.equal(premier.actifs, undefined);
  assert.equal(ongletActif(choisirOnglet(premier, DROITE, `${DROITE}#a`), DROITE), `${DROITE}#a`);
  // L'onglet d'une autre colonne n'est pas un choix possible ici.
  assert.equal(ongletActif(choisirOnglet(premier, DROITE, `${GAUCHE}#a`), DROITE), DROITE);
});

test('fermer l’onglet affiché montre celui qui le précédait', () => {
  let c = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  c = ajouterOnglet(c, DROITE, 'b');
  c = retirerOnglet(c, DROITE, `${DROITE}#b`);
  assert.equal(ongletActif(c, DROITE), `${DROITE}#a`);
  c = retirerOnglet(c, DROITE, `${DROITE}#a`);
  assert.equal(ongletActif(c, DROITE), DROITE);
  // Revenue à un seul onglet, la colonne retrouve sa forme d'avant les onglets.
  assert.deepEqual(c, colonnesDefaut(CONNUES));
});

test('le premier onglet ne se ferme pas : il est la colonne', () => {
  const c = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  assert.deepEqual(retirerOnglet(c, DROITE, DROITE), c);
});

test('inverser et replier gardent les onglets de chaque colonne', () => {
  let c = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  c = ajouterOnglet(c, GAUCHE, 'b');
  c = choisirOnglet(c, GAUCHE, GAUCHE);
  const apres = basculerMasquee(inverserColonnes(c), DROITE);
  assert.deepEqual(apres.onglets, c.onglets);
  assert.deepEqual(apres.actifs, c.actifs);
  assert.equal(ongletActif(apres, DROITE), `${DROITE}#a`);
});

test('des onglets se relisent tels quels', () => {
  let c = ajouterOnglet(colonnesDefaut(CONNUES), DROITE, 'a');
  c = ajouterOnglet(c, DROITE, 'b');
  c = choisirOnglet(c, DROITE, `${DROITE}#a`);
  assert.deepEqual(lireColonnes(JSON.parse(JSON.stringify(c)), CONNUES), c);
});

test('un onglet stocké sous la mauvaise colonne ou illisible est ignoré', () => {
  const c = lireColonnes({
    ordre: [GAUCHE, DROITE],
    onglets: { [DROITE]: [`${GAUCHE}#x`, `${DROITE}#`, 7, `${DROITE}#ok`, `${DROITE}#ok`], 'chat.disparue': ['chat.disparue#a'] },
    actifs: { [DROITE]: `${DROITE}#inconnu`, [GAUCHE]: 3 },
  }, CONNUES);
  assert.deepEqual(ongletsDe(c, DROITE), [DROITE, `${DROITE}#ok`]);
  assert.equal(ongletActif(c, DROITE), DROITE);
  assert.equal(c.actifs, undefined);
  assert.deepEqual(Object.keys(c.onglets ?? {}), [DROITE]);
});

// ── Persistance : les colonnes voyagent par `ui_layout`, sur leur propre scope.

/** Un daemon en mémoire, une valeur par scope. */
function fauxDaemon() {
  const stocke = new Map<string, unknown>();
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const scope = new URL(url, 'http://x').searchParams.get('scope') ?? 'cockpit';
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ scope, layout: stocke.get(scope) ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    stocke.set(scope, JSON.parse(String(init?.body)).layout);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { fetchImpl, stocke };
}

test('un ordre inversé survit à l’aller-retour par le daemon', async () => {
  const daemon = fauxDaemon();
  const inverse = inverserColonnes(colonnesDefaut(CONNUES));

  assert.equal(await saveLayout(inverse, ioColonnes({ fetchImpl: daemon.fetchImpl })), true);
  const out = await loadLayout(ioColonnes({ fetchImpl: daemon.fetchImpl }));

  assert.equal(out.ok, true);
  assert.deepEqual(lireColonnes(out.raw, CONNUES), inverse);
  assert.deepEqual([...daemon.stocke.keys()], [CHAT_COLUMNS_SCOPE], 'le cockpit n’est pas touché');
});

test('le layout laissé au navigateur n’est jamais repris comme ordre de colonnes', async () => {
  const daemon = fauxDaemon();
  const cockpit = [{ id: 'agenda', rail: 'gauche', rang: 0, hauteur: 200 }];
  const storage = {
    getItem: (k: string) => (k === LEGACY_LAYOUT_KEY ? JSON.stringify(cockpit) : null),
    removeItem: () => { throw new Error('la migration du cockpit ne doit pas courir ici'); },
  };

  const out = await loadLayout(ioColonnes({ fetchImpl: daemon.fetchImpl, storage }));

  assert.deepEqual(out, { raw: null, ok: true, migrated: false });
  assert.equal(daemon.stocke.size, 0, 'rien n’a été écrit sur le scope des colonnes');
});

test('daemon injoignable : la lecture le dit, et rien n’est écrit', async () => {
  const fetchImpl = async () => { throw new Error('réseau coupé'); };
  const out = await loadLayout(ioColonnes({ fetchImpl }));
  assert.deepEqual(out, { raw: null, ok: false, migrated: false });
  // C’est ce `ok: false` que le hook garde : sans lui, les défauts seraient
  // sauvés par-dessus un ordre qu’on a seulement échoué à lire.
  assert.deepEqual(lireColonnes(out.raw, CONNUES), colonnesDefaut(CONNUES));
});

test('largeur : absente = défaut, posée = bornée, null = retour au défaut', () => {
  const c = lireColonnes(null, CONNUES);
  assert.equal(largeurDe(c, DROITE, 300), 300);
  const large = poserLargeur(c, DROITE, 455.4);
  assert.equal(largeurDe(large, DROITE, 300), 455);
  assert.equal(largeurDe(poserLargeur(c, DROITE, 10), DROITE, 300), LARGEUR_MIN);
  assert.equal(largeurDe(poserLargeur(c, DROITE, 99999), DROITE, 300), LARGEUR_MAX);
  const defaut = poserLargeur(large, DROITE, null);
  assert.equal(defaut.largeurs, undefined, 'back to the default, the stored value regains its old shape');
});

test('largeur : une valeur stockée illisible ou hors colonnes est ignorée', () => {
  const c = lireColonnes({ largeurs: { [DROITE]: 'large', [GAUCHE]: 5000, 'chat.disparue': 400 } }, CONNUES);
  assert.deepEqual(c.largeurs, { [GAUCHE]: LARGEUR_MAX });
});

test('deuxième colonne : un onglet montré à côté, sans changer l’onglet affiché', () => {
  const c = choisirOnglet(ajouterOnglet(lireColonnes(null, CONNUES), DROITE, 'a'), DROITE, DROITE);
  const s = ajouterSeconde(c, DROITE, 'b');
  assert.equal(secondeDe(s, DROITE), `${DROITE}#b`);
  assert.deepEqual(ongletsDe(s, DROITE), [DROITE, `${DROITE}#a`, `${DROITE}#b`], 'une entrée d’onglet par colonne');
  assert.equal(ongletActif(s, DROITE), DROITE);
  assert.equal(secondeDe(s, GAUCHE), null);
  assert.deepEqual(ajouterSeconde(s, DROITE, 'c'), s, 'une seule deuxième colonne par côté');
});

test('deuxième colonne : la détacher la laisse en onglet, la fermer l’oublie avec sa largeur', () => {
  const s = poserLargeur(ajouterSeconde(lireColonnes(null, CONNUES), GAUCHE, 'b'), `${GAUCHE}#b`, 400);
  const detachee = detacherSeconde(s, GAUCHE);
  assert.equal(secondeDe(detachee, GAUCHE), null);
  assert.deepEqual(ongletsDe(detachee, GAUCHE), [GAUCHE, `${GAUCHE}#b`]);
  const fermee = retirerOnglet(s, GAUCHE, `${GAUCHE}#b`);
  assert.equal(fermee.secondes, undefined);
  assert.equal(fermee.largeurs, undefined);
});

test('deuxième colonne : relue telle quelle, ignorée si elle ne nomme pas un onglet', () => {
  const s = ajouterSeconde(lireColonnes(null, CONNUES), DROITE, 'b');
  assert.deepEqual(lireColonnes(JSON.parse(JSON.stringify(s)), CONNUES), s);
  const faux = lireColonnes({ ...s, secondes: { [DROITE]: `${GAUCHE}#b`, [GAUCHE]: 4 } }, CONNUES);
  assert.equal(faux.secondes, undefined);
});

test('inverser garde la deuxième colonne et les largeurs de chaque zone', () => {
  const s = poserLargeur(ajouterSeconde(lireColonnes(null, CONNUES), DROITE, 'b'), DROITE, 500);
  const inv = inverserColonnes(s);
  assert.deepEqual(inv.secondes, s.secondes);
  assert.deepEqual(inv.largeurs, s.largeurs);
});

test('plan : gouttière d’origine à gauche, poignée dégagée à droite, aux largeurs par défaut', () => {
  const plan = planifierRails(1400, { largeur: 280, premiere: true, seconde: null }, { largeur: 300, premiere: true, seconde: null });
  assert.equal(plan.gauche?.gouttiere, 312);
  assert.equal(plan.droite?.gouttiere, 328, 'clears the handle past the column edge');
  assert.equal(plan.marge, 1400 - FIL_MIN - 640);
});

test('plan : assez de place, les deux colonnes de chaque côté sont posées', () => {
  const plan = planifierRails(3000, { largeur: 300, premiere: true, seconde: 300 }, { largeur: 300, premiere: true, seconde: 400 });
  assert.equal(plan.droite?.seconde, 400);
  assert.equal(plan.droite?.decalageSeconde, 312);
  assert.equal(plan.droite?.gouttiere, 16 + 300 + 12 + 400 + 12);
  assert.equal(plan.gauche?.secondeRepliee, false);
});

test('plan : trop étroit, la deuxième colonne du côté le plus large se replie d’abord', () => {
  const g = { largeur: 300, premiere: true, seconde: 300 };
  const d = { largeur: 300, premiere: true, seconde: 400 };
  // Room for one second column, not two.
  const plan = planifierRails(FIL_MIN + 644 + 328, g, d);
  assert.equal(plan.droite?.seconde, null);
  assert.equal(plan.droite?.secondeRepliee, true);
  assert.equal(plan.gauche?.seconde, 300);
});

test('plan : une deuxième colonne seule (la colonne vide) prend le bord, et se replie dans la colonne', () => {
  const seule = planifierRails(3000, null, { largeur: 300, premiere: false, seconde: 350 });
  assert.equal(seule.droite?.premiere, null);
  assert.equal(seule.droite?.decalageSeconde, 0);
  assert.equal(seule.droite?.gouttiere, 378);
  const repliee = planifierRails(FIL_MIN + 330, null, { largeur: 300, premiere: false, seconde: 350 });
  assert.equal(repliee.droite?.premiere, 300, 'its tab folds back into the column, which shows again');
  assert.equal(repliee.droite?.seconde, null);
});

test('plan : plus étroit encore, les largeurs rétrécissent sans passer sous le minimum', () => {
  const plan = planifierRails(FIL_MIN + 700, { largeur: 500, premiere: true, seconde: null }, { largeur: 500, premiere: true, seconde: null });
  assert.ok((plan.gauche?.premiere ?? 0) < 500);
  assert.ok((plan.gauche?.premiere ?? 0) >= LARGEUR_MIN);
  assert.ok((plan.gauche?.gouttiere ?? 0) + (plan.droite?.gouttiere ?? 0) <= 700);
  const minuscule = planifierRails(FIL_MIN + 100, { largeur: 500, premiere: true, seconde: null }, null);
  assert.equal(minuscule.gauche?.premiere, LARGEUR_MIN);
  assert.equal(minuscule.marge, 0);
});

test('plan : largeur pas encore mesurée, tout est posé tel que demandé', () => {
  const plan = planifierRails(0, { largeur: 300, premiere: true, seconde: 300 }, null);
  assert.equal(plan.gauche?.seconde, 300);
  assert.equal(plan.marge, Number.POSITIVE_INFINITY);
});

test('a tab name survives every mutation, leaves with its tab, and is bounded', async () => {
  const { ajouterOnglet, lireColonnes, nommerOnglet, retirerOnglet, inverserColonnes, NOM_ONGLET_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  let c = ajouterOnglet(lireColonnes(null, zones), 'chat.right.widget', 'k1');
  c = nommerOnglet(c, 'chat.right.widget#k1', '  Ops\n  board ');
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board');
  c = inverserColonnes(c);
  assert.equal(c.noms?.['chat.right.widget#k1'], 'Ops board', 'another mutation keeps the name');
  assert.deepEqual(lireColonnes(JSON.parse(JSON.stringify(c)), zones).noms, { 'chat.right.widget#k1': 'Ops board' });
  assert.equal(nommerOnglet(c, 'chat.left.widget', 'x'.repeat(60)).noms?.['chat.left.widget']?.length, NOM_ONGLET_MAX);
  assert.equal(nommerOnglet(c, 'chat.right.widget#k1', null).noms, undefined, 'an unnamed column writes no field');
  assert.equal(retirerOnglet(c, 'chat.right.widget', 'chat.right.widget#k1').noms, undefined, 'a closed tab takes its name along');
  assert.equal(lireColonnes({ noms: { 'chat.left.widget#ghost': 'x' } }, zones).noms, undefined);
});

// TODO #647 : un clic rejoué sur l’écriture d’une autre fenêtre garde son sens.
test('replier une colonne déjà repliée ailleurs la laisse repliée', () => {
  const c = colonnesDefaut(CONNUES);
  const replie = poserMasquee(c, GAUCHE, true);
  assert.equal(estMasquee(replie, GAUCHE), true);
  assert.equal(poserMasquee(replie, GAUCHE, true), replie);
  assert.deepEqual(poserMasquee(replie, GAUCHE, false), c);
});

test('a column resized with its mirror: both move by the same amount, held by the first bound', async () => {
  const { largeursJumelees, LARGEUR_MIN } = await import('../components/chat/chat-columns');
  // Room for 200px more in all: two columns growing at once share it.
  assert.deepEqual(largeursJumelees(300, 500, 500, { largeur: 300, max: 500 }), { largeur: 400, jumelle: 400 });
  assert.deepEqual(largeursJumelees(300, 340, 500, { largeur: 280, max: 480 }), { largeur: 340, jumelle: 320 }, 'an asymmetry is kept, not erased');
  // Shrinking stops at the floor of whichever reaches it first.
  assert.deepEqual(largeursJumelees(300, 100, 500, { largeur: LARGEUR_MIN + 20, max: 500 }), { largeur: 280, jumelle: LARGEUR_MIN });
});

test('the reading column width is stored clamped, and null gives it back to the room', async () => {
  const { poserFil, lireColonnes, FIL_LECTURE_MIN, FIL_LECTURE_MAX } = await import('../components/chat/chat-columns');
  const zones = ['chat.left.widget', 'chat.right.widget'];
  const base = lireColonnes({}, zones);
  assert.equal(base.fil, undefined);
  assert.equal(poserFil(base, 900).fil, 900);
  assert.equal(poserFil(base, 10).fil, FIL_LECTURE_MIN);
  assert.equal(poserFil(base, 99999).fil, FIL_LECTURE_MAX);
  assert.equal(poserFil(poserFil(base, 900), null).fil, undefined);
  // Read back from storage, and dropped when unreadable.
  assert.equal(lireColonnes({ fil: 1000 }, zones).fil, 1000);
  assert.equal(lireColonnes({ fil: 'wide' }, zones).fil, undefined);
});
