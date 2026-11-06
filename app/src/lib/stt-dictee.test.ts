import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DICTEE_GRACE_MS,
  composerDictee,
  doitRelancerDictee,
  erreurDicteeFatale,
  texteSession,
  webSpeechSansMoteur,
} from './stt-dictee';

test('une hésitation courte relance l’écoute', () => {
  assert.equal(
    doitRelancerDictee({ arretManuel: false, erreurFatale: false, depuisDerniereActivite: 1_200 }),
    true,
  );
});

test('le silence au-delà de la fenêtre clôt la dictée', () => {
  assert.equal(
    doitRelancerDictee({
      arretManuel: false,
      erreurFatale: false,
      depuisDerniereActivite: DICTEE_GRACE_MS,
    }),
    false,
  );
});

test('un stop demandé par l’utilisateur ne relance jamais', () => {
  assert.equal(
    doitRelancerDictee({ arretManuel: true, erreurFatale: false, depuisDerniereActivite: 0 }),
    false,
  );
});

test('une erreur fatale coupe la boucle de relance', () => {
  assert.equal(
    doitRelancerDictee({ arretManuel: false, erreurFatale: true, depuisDerniereActivite: 0 }),
    false,
  );
});

test('la fenêtre est paramétrable pour les appelants qui la règlent', () => {
  assert.equal(
    doitRelancerDictee({
      arretManuel: false,
      erreurFatale: false,
      depuisDerniereActivite: 900,
      graceMs: 500,
    }),
    false,
  );
});

test('micro refusé ou volé = fatal, fin de tour ordinaire = non', () => {
  assert.equal(erreurDicteeFatale('not-allowed'), true);
  assert.equal(erreurDicteeFatale('audio-capture'), true);
  assert.equal(erreurDicteeFatale('service-not-allowed'), true);
  assert.equal(erreurDicteeFatale('no-speech'), false);
  assert.equal(erreurDicteeFatale('aborted'), false);
});

test('TIM-0061: an unreachable recognition service ends the dictation', () => {
  assert.equal(erreurDicteeFatale('network'), true);
  assert.equal(
    doitRelancerDictee({ arretManuel: false, erreurFatale: erreurDicteeFatale('network'), depuisDerniereActivite: 0 }),
    false,
  );
});

test('TIM-0061: Web Speech has no engine in the desktop app', () => {
  const electronWin =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) timon-desktop/0.1.3 Chrome/130.0.6723.191 Electron/33.2.0 Safari/537.36';
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.equal(webSpeechSansMoteur({ userAgent: electronWin, desktopBridge: false }), true);
  assert.equal(webSpeechSansMoteur({ userAgent: chrome, desktopBridge: true }), true);
  assert.equal(webSpeechSansMoteur({ userAgent: chrome, desktopBridge: false }), false);
});

test('le repli conserve le texte déjà dicté et pose une espace', () => {
  assert.equal(composerDictee('bonjour', 'tout le monde'), 'bonjour tout le monde');
  assert.equal(composerDictee('bonjour ', 'tout le monde'), 'bonjour tout le monde');
  assert.equal(composerDictee('', 'bonjour'), 'bonjour');
  assert.equal(composerDictee('bonjour', '   '), 'bonjour');
  assert.equal(composerDictee('', ''), '');
});

test('deux segments finalisés et un interim donnent la phrase complète', () => {
  assert.equal(
    texteSession([
      { isFinal: true, transcript: 'bonjour' },
      { isFinal: true, transcript: 'tout le monde' },
      { isFinal: false, transcript: 'et bonne' },
    ]),
    'bonjour tout le monde et bonne',
  );
});

test('un resultIndex avancé ne fait rien perdre : on repart toujours de zéro', () => {
  // Ce que le moteur envoie après une pause : le segment 0 est figé, l'index
  // pointe le nouveau. L'ancienne boucle ne rendait que « la suite ».
  const results = [
    { isFinal: true, transcript: 'le début de ma phrase' },
    { isFinal: false, transcript: 'la suite' },
  ];
  assert.equal(texteSession(results), 'le début de ma phrase la suite');
});

test('l’interim d’un tour remplace celui d’avant sans dupliquer', () => {
  const finalise = { isFinal: true, transcript: 'bonjour' };
  assert.equal(texteSession([finalise, { isFinal: false, transcript: 'tou' }]), 'bonjour tou');
  assert.equal(texteSession([finalise, { isFinal: false, transcript: 'tout le' }]), 'bonjour tout le');
  assert.equal(
    texteSession([finalise, { isFinal: true, transcript: 'tout le monde' }]),
    'bonjour tout le monde',
  );
});

test('un moteur qui réémet la phrase entière à chaque event ne la duplique pas', () => {
  // Capture du 10/10 : « salut salut comment salut comment ça salut comment ça va ».
  const copies = ['salut', 'salut comment', 'salut comment ça', 'salut comment ça va'];
  assert.equal(
    texteSession(copies.map((transcript) => ({ isFinal: true, transcript }))),
    'salut comment ça va',
  );
  assert.equal(
    texteSession([
      ...copies.slice(0, 3).map((transcript) => ({ isFinal: true, transcript })),
      { isFinal: false, transcript: 'Salut, comment ça va ?' },
    ]),
    'Salut, comment ça va ?',
  );
});

test('une liste vide, ou vide de parole, rend la chaîne vide', () => {
  assert.equal(texteSession([]), '');
  assert.equal(texteSession([{ isFinal: false, transcript: '   ' }]), '');
});

test('dicte A, relance, dicte B : le champ porte « A B », une seule fois chacun', () => {
  // Séquence complète telle que la vit `chat-client` : la base est vide, la
  // session A se compose, `onend` la replie, la session B repart d'un
  // `results` neuf.
  let base = '';
  let session = texteSession([
    { isFinal: true, transcript: 'première' },
    { isFinal: false, transcript: 'phrase' },
  ]);
  assert.equal(composerDictee(base, session), 'première phrase');

  session = texteSession([
    { isFinal: true, transcript: 'première' },
    { isFinal: true, transcript: 'phrase' },
  ]);
  // Repli de `onend` avant la relance.
  base = composerDictee(base, session);
  session = '';
  assert.equal(base, 'première phrase');

  session = texteSession([{ isFinal: false, transcript: 'deuxième phrase' }]);
  assert.equal(composerDictee(base, session), 'première phrase deuxième phrase');
});
