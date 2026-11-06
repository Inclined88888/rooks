import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-license-test-'));
const { effectiveEdition, fingerprintHash, installLicenseToken, readLicense, verifyLicenseToken } = await import('./license/license.js');
const { overrideKeyringForTests } = await import('./license/pubkey.js');
const { fileClockAnchor, readLicenseStore } = await import('./license/store.js');
const { setLicenseState, licenseState } = await import('./license/runtime.js');
const { deviceId, rotateDeviceId } = await import('./license/device.js');
const { fingerprint, machineId } = await import('./license/fingerprint.js');
const { registerRoutes } = await import('./kernel/routes/license.js');
const { attachBundledReconciler } = await import('./kernel/bundled-reload.js');
const { attachPluginLoader } = await import('./plugins/runtime.js');
const { applyLicensedSurfaces } = await import('./kernel/routes/license.js');

// Copie vendue du contrat figé (`timon-site/fixtures/token-claims.json`) : les
// tests ne lisent jamais un chemin absolu vers l'autre dépôt.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as {
  examples: { name: string; header: Record<string, unknown>; claims: Record<string, unknown> }[];
};
const example = (name: string) => {
  const found = fixture.examples.find((e) => e.name === name);
  assert.ok(found, `exemple ${name} absent de la fixture`);
  return found;
};

const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const now = Math.floor(Date.now() / 1000);
/** Identifiant d'appareil de CE daemon : les jetons de test sont émis pour lui,
 *  comme le serveur émet pour le `deviceId()` que l'activation lui a envoyé. */
const DEVICE = deviceId();
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Claims du contrat, recalés sur l'horloge du test (la fixture est datée). */
/** The fixture carries `fph` for the machine whose `fp` is 64 zeros; tokens
 *  for THIS machine drop it unless a test binds one on purpose. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { fph: _fph, ...base } = example('beta-1-year').claims;
  return { ...base, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now, ...overrides };
}
const FIXTURE_FP = '0'.repeat(64);
function signed(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'test', ...header })}.${enc(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
const token = (overrides: Record<string, unknown> = {}) => signed(claims(overrides));
/** La liaison appareil n'est plus optionnelle : sauf quand le test la vise,
 *  la vérification part de l'identifiant réel de la machine de test. */
const verify = (tok: string, opts: Record<string, unknown> = {}) =>
  verifyLicenseToken(tok, { keys, device: DEVICE, ...opts });

/** Who the express tests call as. Superadmin daemon-token unless a test says otherwise. */
type Caller = { kind: 'daemon-token' | 'session' | 'api-token'; isSuperadmin: boolean };
let caller: Caller = { kind: 'daemon-token', isSuperadmin: true };
const asCaller: express.RequestHandler = (req, _res, next) => {
  req.auth = { kind: caller.kind, user: null, isSuperadmin: caller.isSuperadmin } as typeof req.auth;
  next();
};
/** Signs a licence-server answer the way `timon-site` does (§5.9). */
function signedAnswer(init: RequestInit | undefined, status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  const nonce = new Headers(init?.headers).get('x-timon-nonce') ?? '';
  const signature = `test.${sign(null, Buffer.from(`${nonce}\n${status}\n${text}`), pair.privateKey).toString('base64url')}`;
  return new Response(text, { status, headers: { 'content-type': 'application/json', 'x-timon-signature': signature } });
}

test('absence de fichier : Free local, tout le produit, un seul compte', () => {
  const state = readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys });
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.edition, 'expert');
  assert.equal(effectiveEdition('expert', state.edition), 'expert');
  assert.equal(effectiveEdition('lite', state.edition), 'lite', 'the lite preset stays the owner\'s choice');
});

test('an empty keyring never grants paid capabilities, with or without a token', () => {
  const file = join(process.env.TIMON_HOME!, 'empty-keyring.jwt');
  for (const present of [false, true]) {
    if (present) writeFileSync(file, token());
    const state = readLicense(file, { keys: [] });
    assert.equal(state.status, 'unlicensed');
    assert.equal(state.reason, present ? 'invalid:key' : 'missing');
    // Free is the whole product for one person: what a paid licence adds is
    // accounts, and an unverifiable token never unlocks them.
    assert.equal(state.localFree, true);
    assert.equal(state.modules, '*');
    assert.equal(state.users, 1);
    assert.equal(state.capabilities?.accounts, 'single-superadmin');
  }
});

test('les exemples du contrat sont acceptés', () => {
  for (const name of ['beta-1-year', 'beta-lifetime', 'developer']) {
    const source = example(name);
    // `did` recalé sur cet appareil, comme le serveur émet pour le device
    // qu'on lui a déclaré ; le reste des claims est celui du contrat.
    const state = verify(signed({ ...source.claims, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now }), { fingerprint: FIXTURE_FP });
    assert.equal(state.status, 'valid', name);
    // The fixture's `fph` is a real binding: another machine is refused.
    assert.equal(verify(signed({ ...source.claims, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now }), { fingerprint: '1'.repeat(64) }).reason, 'invalid:fingerprint', name);
    assert.equal(state.reason, null);
    assert.equal(state.edition, 'expert');
    assert.deepEqual(state.modules, source.claims.modules);
    assert.equal(state.plugins, '*');
    assert.equal(state.paymentStatus, 'active');
  }
});

test('sub_exp null (plan developer) passe, sub_exp daté est rendu en ISO', () => {
  const developer = example('developer').claims;
  assert.equal(developer.sub_exp, null);
  const verified = verify(signed({ ...developer, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now }), { fingerprint: FIXTURE_FP });
  assert.equal(verified.status, 'valid');
  assert.equal(verified.planId, 'internal');
  assert.equal(verified.subscriptionExpiresAt, null);
  const dated = verify(token({ sub_exp: 1767225600 }));
  assert.equal(dated.subscriptionExpiresAt, new Date(1767225600 * 1000).toISOString());
});

test('les claims du contrat traversent le schéma sans être perdus', () => {
  // Détection de dérive : si le serveur renomme un claim, la fixture change et
  // ce test le dit — sans jamais rejeter un jeton pour un claim informatif.
  const state = verify(token());
  const source = claims();
  assert.equal(state.edition, source.edition);
  assert.deepEqual(state.modules, source.modules);
  assert.equal(state.plugins, source.plugins);
  assert.equal(state.expiresAt, new Date((source.exp as number) * 1000).toISOString());
  for (const claim of ['sub', 'lic', 'did', 'plan', 'edition', 'modules', 'plugins', 'features', 'seats', 'iat', 'nbf', 'exp', 'srv', 'jti', 'status']) {
    assert.ok(claim in source, `claim ${claim} absent du contrat`);
  }
  // `plan_name` est l'un des trois claims optionnels (avec `fph` et `users`) :
  // il est arrivé après le gel du contrat, les jetons déjà émis ne le portent pas. Présent, c'est lui qu'on
  // montre ; absent, l'identifiant de plan fait l'affaire.
  assert.equal(verify(token()).plan, source.plan_name);
  const { plan_name: _omit, ...sansLabel } = source;
  assert.equal(verify(signed(sansLabel)).plan, source.plan);
});

test('v4: seats null is an unlimited-machines licence, not a malformed token', () => {
  // Typed as a plain integer until v4, which made an unlimited licence
  // unusable client-side (`invalid:format`) even though the server had
  // signed it.
  const state = verify(token({ seats: null }));
  assert.equal(state.status, 'valid');
  assert.equal(state.reason, null);
  // Still a required key: a token that dropped it did not come from the server.
  const { seats: _omit, ...sansSeats } = claims();
  assert.equal(verify(signed(sansSeats)).reason, 'invalid:format');
});

test('v4: the users quota travels, and its absence restricts nothing', () => {
  assert.equal(verify(token({ users: 3 })).users, 3);
  // `null` = unlimited profiles, and so does the absent claim: tokens issued
  // before v4 carry none and must not suddenly cap an install.
  assert.equal(verify(token({ users: null })).users, null);
  const { users: _omit, ...sansUsers } = claims();
  const state = verify(signed(sansUsers));
  assert.equal(state.status, 'valid');
  assert.equal(state.users, null);
  // A malformed quota is a malformed token — no silent fallback to unlimited.
  assert.equal(verify(token({ users: 'three' })).reason, 'invalid:format');
  // TODO #551: zero would lock every profile out; unlimited is `null`.
  assert.equal(verify(token({ users: 0 })).reason, 'invalid:format');
  assert.equal(verify(token({ users: -1 })).reason, 'invalid:format');
});

test('licence lite restreint une config expert', () => {
  assert.equal(effectiveEdition('expert', verify(token({ edition: 'lite' })).edition), 'lite');
});

test('status past_due reste une licence valide (bannière, pas refus)', () => {
  const state = verify(token({ status: 'past_due' }));
  assert.equal(state.status, 'valid');
  assert.equal(state.paymentStatus, 'past_due');
  assert.equal(state.modules !== '*' && state.modules.length > 0, true);
});

test('gardes d\'horloge : iat, nbf et srv', () => {
  assert.equal(verify(token({ iat: now + 120 })).reason, 'invalid:clock');
  assert.equal(verify(token({ nbf: now + 120 })).reason, 'invalid:clock');
  // Tolérance de 60 s : un nbf juste dans le futur passe.
  assert.equal(verify(token({ nbf: now + 30 })).status, 'valid');
  assert.equal(verify(token({ srv: now + 7200 })).reason, 'invalid:clock');
});

test('expiration : plus de grâce locale, le jeton périmé est refusé', () => {
  assert.equal(verify(token({ exp: now - 120 })).reason, 'expired');
  // 14 jours de grâce n'existent plus (PRD 03 : révocation ≤ 15 min).
  assert.equal(verify(token({ exp: now - 86400 })).status, 'unlicensed');
  // Tolérance d'horloge : une expiration à la seconde près ne rejette pas.
  assert.equal(verify(token({ exp: now - 30 })).status, 'valid');
});

test('un plan à vie expire comme les autres : « à vie » qualifie l\'abonnement, pas le jeton (L-2)', () => {
  // Jusqu'au 04/09 un jeton `sub_exp: null` ignorait `exp` : bearer permanent,
  // duplicable, irrévocable. La boucle de renouvellement existe désormais, le
  // garde n'a plus de raison d'être levé.
  const aVie = verify(token({ sub_exp: null, exp: now - 86400 }));
  assert.equal(aVie.status, 'unlicensed');
  assert.equal(aVie.reason, 'expired');
  const frais = verify(token({ sub_exp: null }));
  assert.equal(frais.status, 'valid');
  assert.equal(frais.lifetime, true);
  // Le jeton annonce son échéance, comme tous les autres.
  assert.equal(typeof frais.expiresAt, 'string');
  assert.equal(verify(token({ sub_exp: now + 86400 })).lifetime, false);
  // Un abonnement daté garde son expiration.
  assert.equal(verify(token({ sub_exp: now + 86400, exp: now - 120 })).reason, 'expired');
});

test('tolérance hors-ligne : graceUntil accepte un jeton périmé, jusqu\'à l\'instant donné (L-7)', () => {
  const expired = token({ exp: now - 3600 });
  assert.equal(verify(expired, { graceUntil: now + 60 }).status, 'valid');
  assert.equal(verify(expired, { graceUntil: now - 1 }).reason, 'expired');
});

test('srv mesure une dérive, jamais un âge (L-6)', () => {
  // Relu depuis le disque, un jeton vieux de 48 h dont l'exp tient encore
  // (artificiel : TTL 15 min) n'est pas refusé pour son `srv` ancien.
  const ancien = token({ iat: now - 172_800, nbf: now - 172_860, srv: now - 172_800, exp: now + 900 });
  assert.equal(verify(ancien).status, 'valid');
  // Le même jeton qui ARRIVE du serveur trahit une horloge fausse d'un jour.
  assert.equal(verify(ancien, { fresh: true }).reason, 'invalid:clock');
  // Deux valeurs serveur qui divergent : le jeton n'est pas cohérent.
  assert.equal(verify(token({ srv: now - 7200 })).reason, 'invalid:clock');
  // Un jeton frais dont srv colle à l'horloge locale passe.
  assert.equal(verify(token(), { fresh: true }).status, 'valid');
});

test('fph : le jeton est lié à la machine, pas seulement au fichier device-id (L-2)', () => {
  const fp = 'a'.repeat(64);
  assert.equal(verify(token({ fph: fingerprintHash(fp) }), { fingerprint: fp }).status, 'valid');
  assert.equal(verify(token({ fph: fingerprintHash(fp) }), { fingerprint: 'b'.repeat(64) }).reason, 'invalid:fingerprint');
  // Sans `fph` (jeton d'avant l'amendement), la liaison `did` seule s'applique.
  assert.equal(verify(token(), { fingerprint: 'b'.repeat(64) }).status, 'valid');
  // Grammaire stricte : un `fph` mal formé est un jeton mal formé.
  assert.equal(verify(token({ fph: 'zz' })).reason, 'invalid:format');
});

test('ancre d\'horloge : un srv plus ancien qu\'un déjà accepté, ou une horloge locale reculée, est refusé (L-5)', () => {
  const file = join(process.env.TIMON_HOME!, 'anchor-test.json');
  const anchor = fileClockAnchor(file);
  assert.equal(verify(token(), { anchor }).status, 'valid');
  assert.equal(readLicenseStore(file).maxSrv, now);
  // Un jeton émis avant celui-là : rejoué ou ressuscité par faketime.
  assert.equal(verify(token({ iat: now - 3600, nbf: now - 3660, srv: now - 3600, exp: now + 900 }), { anchor }).reason, 'invalid:clock:rollback');
  // Une horloge locale deux jours en arrière du dernier instant vu.
  const past = new Date((now - 2 * 86400) * 1000);
  assert.equal(verify(token({ iat: now - 2 * 86400, nbf: now - 2 * 86400 - 60, srv: now - 2 * 86400, exp: now - 2 * 86400 + 900 }), { anchor, now: past }).reason, 'invalid:clock:rollback');
  // Une minute de dérive entre deux serveurs n'est pas un recul.
  assert.equal(verify(token({ iat: now - 30, nbf: now - 90, srv: now - 30 }), { anchor }).status, 'valid');
  // Un refus ne déplace pas l'ancre.
  assert.equal(readLicenseStore(file).maxSrv, now);
});

test('did : la liaison appareil est obligatoire, jamais implicite', () => {
  // Un jeton émis pour une AUTRE machine ne tourne pas ici, même signé.
  assert.equal(verify(token({ did: example('beta-1-year').claims.did as string })).reason, 'invalid:machine');
  assert.equal(verify(token({ did: 'dev_0000000000000000' })).reason, 'invalid:machine');
  // `did` absent : claim requis du contrat, donc format — pas un laissez-passer.
  const { did: _did, ...withoutDid } = claims();
  assert.equal(verify(signed(withoutDid)).reason, 'invalid:format');
  // Sans `device` explicite, la vérification résout l'identifiant du daemon.
  assert.equal(verifyLicenseToken(token(), { keys }).status, 'valid');
  assert.equal(verifyLicenseToken(token({ did: 'dev_0000000000000000' }), { keys }).reason, 'invalid:machine');
});

test('deviceId : opaque, persistant, identique à celui que readLicense compare', () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  assert.match(DEVICE, /^dev_[0-9a-f]{16}$/);
  // Persistance : deux appels rendent le même id, et il est bien sur le disque.
  assert.equal(deviceId(), DEVICE);
  assert.equal(readFileSync(join(process.env.TIMON_HOME!, 'device-id'), 'utf8').trim(), DEVICE);
  // Chemin de production : readLicense sans `device` explicite lit ce fichier.
  writeFileSync(file, token());
  assert.equal(readLicense(file, { keys }).status, 'valid');
  // Le même jeton, émis pour un autre appareil, est refusé par ce chemin-là.
  writeFileSync(file, token({ did: 'dev_ffffffffffffffff' }));
  assert.equal(readLicense(file, { keys }).reason, 'invalid:machine');
});

test('installation neuve : le device est tiré au vol, un jeton d\'avant est refusé', () => {
  // Le cas que le test précédent ne couvre PAS : aucune `device-id` sur le
  // disque encore. C'est le premier boot après réinstallation, avec un jeton
  // hérité de l'installation d'avant — il doit tomber, pas passer par défaut.
  const fresh = mkdtempSync(join(tmpdir(), 'timon-license-fresh-'));
  const idFile = join(fresh, 'device-id');
  const file = join(fresh, 'license.jwt');
  writeFileSync(file, token({ did: 'dev_ffffffffffffffff' }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).reason, 'invalid:machine');
  // L'identifiant tiré est neuf, persisté, et différent de celui du daemon de test.
  const drawn = readFileSync(idFile, 'utf8').trim();
  assert.match(drawn, /^dev_[0-9a-f]{16}$/);
  assert.notEqual(drawn, DEVICE);
  assert.equal(deviceId(idFile), drawn);
  // Un jeton émis pour CE device neuf passe.
  writeFileSync(file, token({ did: drawn }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).status, 'valid');
});

test('fingerprint : hachage stable du machine-id, jamais l\'identifiant brut', () => {
  // Le contrat §5.8 : 64 hex minuscules, et rien d'autre ne sort de la machine.
  const fp = fingerprint('b8e3f1a2-0000-4c11-9d55-7e0a1b2c3d4e');
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint('b8e3f1a2-0000-4c11-9d55-7e0a1b2c3d4e'), fp);
  assert.notEqual(fp.includes('b8e3f1a2'), true);
  // Deux machines, deux empreintes : c'est tout ce sur quoi le serveur tranche.
  assert.notEqual(fingerprint('une-autre-machine'), fp);
  // Les espaces du fichier ne comptent pas : /etc/machine-id finit par \n.
  assert.equal(fingerprint('  b8e3f1a2-0000-4c11-9d55-7e0a1b2c3d4e\n'), fp);
  // Pas d'empreinte inventée quand l'OS ne rend rien : une valeur bidon lierait
  // l'activation à une machine qui n'existe pas, et le boot suivant se ferait
  // refuser en device_mismatch.
  assert.throws(() => fingerprint(null));
  assert.throws(() => fingerprint('   '));
  // Sur cette machine-ci, l'OS répond : le chemin de production est parcouru.
  const raw = machineId();
  if (raw !== null) assert.match(fingerprint(), /^[0-9a-f]{64}$/);
});

test('rotateDeviceId : sortie de secours du 409 device_mismatch', () => {
  // ~/.timon copié depuis une autre machine : le serveur a rendu
  // device_mismatch, on retire un identifiant neuf et on réactive une fois.
  const home = mkdtempSync(join(tmpdir(), 'timon-license-clone-'));
  const idFile = join(home, 'device-id');
  const file = join(home, 'license.jwt');
  const copied = deviceId(idFile);
  writeFileSync(file, token({ did: copied }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).status, 'valid');

  const rotated = rotateDeviceId(idFile);
  assert.match(rotated, /^dev_[0-9a-f]{16}$/);
  assert.notEqual(rotated, copied);
  // Persisté, donc stable au prochain boot.
  assert.equal(readFileSync(idFile, 'utf8').trim(), rotated);
  assert.equal(deviceId(idFile), rotated);
  // Le jeton hérité de la copie ne vaut plus rien sur cette machine.
  assert.equal(readLicense(file, { keys, device: rotated }).reason, 'invalid:machine');
  // Et le jeton que le serveur émettra pour l'identifiant neuf passe.
  writeFileSync(file, token({ did: rotated }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).status, 'valid');
});

test('header : alg, typ et kid sont validés', () => {
  assert.equal(verify(signed(claims(), { typ: 'JWE' })).reason, 'invalid:format');
  assert.equal(verify(signed(claims(), { alg: 'HS256' })).reason, 'invalid:format');
  assert.equal(verify(signed(claims(), { kid: '' })).reason, 'invalid:format');
});

test('modules : \'*\' ou des ids @timon/*, rien d\'autre', () => {
  assert.equal(verify(token({ modules: '*' })).modules, '*');
  assert.deepEqual(verify(token({ modules: ['@timon/dreams'] })).modules, ['@timon/dreams']);
  assert.equal(verify(token({ modules: ['dreams'] })).reason, 'invalid:format');
  assert.equal(verify(token({ modules: ['@autre/dreams'] })).reason, 'invalid:format');
  // Les ids de plugins, eux, sont des paquets npm tiers : pas de préfixe imposé.
  assert.deepEqual(verify(token({ plugins: ['acme-widget'] })).plugins, ['acme-widget']);
});

test('tous les claims du contrat sont requis (sub_exp nullable, pas optionnel)', () => {
  for (const claim of ['sub', 'lic', 'did', 'plan', 'edition', 'modules', 'plugins', 'features', 'seats', 'iat', 'nbf', 'exp', 'srv', 'jti', 'sub_exp', 'status']) {
    const partial = { ...claims() };
    delete partial[claim];
    assert.equal(verify(signed(partial)).reason, 'invalid:format', `claim ${claim} manquant devrait être refusé`);
  }
  // Les exemples du contrat portent bien tous ces claims.
  for (const name of ['beta-1-year', 'beta-lifetime', 'developer']) {
    for (const claim of ['sub', 'lic', 'did', 'plan', 'edition', 'modules', 'plugins', 'features', 'seats', 'iat', 'nbf', 'exp', 'srv', 'jti', 'sub_exp', 'status']) {
      assert.ok(claim in example(name).claims, `${claim} absent de l'exemple ${name}`);
    }
  }
});

test('kid inconnu, signature falsifiée et format cassé sont distingués', () => {
  assert.equal(verify(token(), { keys: [{ ...keys[0]!, keyId: 'autre' }] }).reason, 'invalid:key');
  const [header, payload, signature] = token().split('.') as [string, string, string];
  const flipped = Buffer.from(signature, 'base64url');
  flipped[0] = flipped[0]! ^ 0xff;
  assert.equal(verify(`${header}.${payload}.${flipped.toString('base64url')}`).reason, 'invalid:signature');
  assert.equal(verify('invalide').reason, 'invalid:format');
  // Claim requis manquant : format, jamais une licence muette.
  const { status: _status, ...withoutStatus } = claims();
  assert.equal(verify(signed(withoutStatus)).reason, 'invalid:format');
});

test('une installation invalide ne remplace pas le fichier', () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  const original = token();
  writeFileSync(file, original);
  const state = installLicenseToken('invalide', file, { keys });
  assert.equal(state.status, 'unlicensed');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('PUT /api/license refuse un JWT invalide sans toucher au fichier', async () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  const original = token();
  writeFileSync(file, original);
  const app = express();
  app.use(express.json());
  app.use(asCaller);
  registerRoutes(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/license`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'invalide' }),
  });
  assert.equal(response.status, 400);
  assert.equal(readFileSync(file, 'utf8'), original);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

// `installLicenseToken` réussi via HTTP exigerait un jeton signé par la clé
// PRIVÉE de production, absente du dépôt par construction (§4 du runbook
// `timon-site`) — comme `PUT /api/license refuse un JWT invalide` plus haut,
// ce chemin ne se joue qu'en refus. `applyLicensedSurfaces` (ce que le
// succès déclencherait) se teste donc directement, hors HTTP.
function fakeApp(): { get(key: string): unknown; set(key: string, value: unknown): unknown } {
  const store = new Map<string, unknown>();
  return { get: (key) => store.get(key), set: (key, value) => { store.set(key, value); return undefined; } };
}

test('applyLicensedSurfaces recompose les modules bundled ET relit les plugins licenciés (lic-6)', async () => {
  const app = fakeApp();
  let reconciled = 0;
  attachBundledReconciler(app, {
    reconcile: () => { reconciled += 1; return Promise.resolve([]); },
    watch: () => () => {},
    dispose: () => {},
  });
  let updated = 0;
  attachPluginLoader(app, { update: () => { updated += 1; return Promise.resolve([]); } } as unknown as Parameters<typeof attachPluginLoader>[1]);

  await applyLicensedSurfaces(app as unknown as Parameters<typeof applyLicensedSurfaces>[0]);
  assert.equal(reconciled, 1);
  assert.equal(updated, 1);
});

test("applyLicensedSurfaces ne fait rien planter hors d'un kernel booté (aucun reconciler/loader attaché)", async () => {
  await assert.doesNotReject(applyLicensedSurfaces(fakeApp() as unknown as Parameters<typeof applyLicensedSurfaces>[0]));
});

test('un reconciler ou un loader qui rejette ne fait pas échouer applyLicensedSurfaces', async () => {
  const app = fakeApp();
  attachBundledReconciler(app, {
    reconcile: () => Promise.reject(new Error('boom')),
    watch: () => () => {},
    dispose: () => {},
  });
  attachPluginLoader(app, { update: () => Promise.reject(new Error('boom')) } as unknown as Parameters<typeof attachPluginLoader>[1]);
  await assert.doesNotReject(applyLicensedSurfaces(app as unknown as Parameters<typeof applyLicensedSurfaces>[0]));
});

test("l'échec de l'installation ne déclenche aucune recomposition", async () => {
  const app = express();
  app.use(express.json());
  app.use(asCaller);
  registerRoutes(app);
  let reconciled = 0;
  attachBundledReconciler(app, {
    reconcile: () => { reconciled += 1; return Promise.resolve([]); },
    watch: () => () => {},
    dispose: () => {},
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/license`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'invalide' }),
    });
    assert.equal(response.status, 400);
    assert.equal(reconciled, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("la licence n'est pas un module du catalogue", async () => {
  // Décision du 30/08 : la licence est une porte du noyau, pas une brique
  // qu'on installe ou qu'on désactive. Elle ne doit donc pas apparaître dans
  // le catalogue — et par conséquent pas non plus comme carte de la galerie,
  // qui dérive de `CATALOG` via `bundledModuleRows`.
  const { CATALOG } = await import('./kernel/catalog.js');
  const { BUNDLED_IDENTITY } = await import('./plugins/bundled-identity.js');
  assert.equal(CATALOG.some((m) => m.id === 'core-license'), false);
  assert.equal('core-license' in BUNDLED_IDENTITY, false);
  // Le compte baisse à mesure que "fin du tier core" sort les modules
  // désactivables du noyau (30/08 : `@timon/projects` est passé `std`, le
  // coffre de secrets `opt`, le centre de notifications `std`, la mémoire `opt`).
  // 05/11/2026 : `@timon/users` y entre.
  assert.equal(CATALOG.filter((m) => m.tier === 'core').length, 8);
});

/**
 * `POST /api/license/activate` calls the license-server client, which uses
 * `globalThis.fetch` (no `opts.fetch` threading through the route). Swapping
 * it for the duration of one test — and delegating anything that is not the
 * license-server call to the real `fetch` — lets these tests hit both the
 * mocked server AND the local express instance through the same global.
 */
async function withMockedLicenseServer<T>(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/license/')) return handler(url, init as RequestInit);
    return original(input as never, init);
  }) as typeof fetch;
  try { return await run(); }
  finally { globalThis.fetch = original; }
}

async function withActivateServer<T>(run: (port: number) => Promise<T>, as: Caller = { kind: 'daemon-token', isSuperadmin: true }): Promise<T> {
  caller = as;
  overrideKeyringForTests(keys);
  const app = express();
  app.use(express.json());
  app.use(asCaller);
  registerRoutes(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try { return await run(port); }
  finally {
    overrideKeyringForTests(null);
    caller = { kind: 'daemon-token', isSuperadmin: true };
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const post = (port: number, path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: path === '/api/license' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('L-3 : les routes d\'installation sont 403 pour un jeton de mission et pour une session non-superadmin', async () => {
  for (const as of [{ kind: 'api-token', isSuperadmin: false }, { kind: 'session', isSuperadmin: false }] as Caller[]) {
    await withActivateServer(async (port) => {
      assert.equal((await post(port, '/api/license', { token: token() })).status, 403, `PUT as ${as.kind}`);
      assert.equal((await post(port, '/api/license/activate', { key: 'TMN-TEST' })).status, 403, `activate as ${as.kind}`);
      // La lecture reste ouverte : c'est la bannière de tout le monde.
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/license`)).status, 200);
    }, as);
  }
  // Un jeton de mission marqué superadmin (n'existe pas, mais le refus doit tenir au `kind`).
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license', { token: token() })).status, 403);
  }, { kind: 'api-token', isSuperadmin: true });
  // La session superadmin passe.
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license', { token: token() })).status, 200);
  }, { kind: 'session', isSuperadmin: true });
});

test('L-3 : une rétrogradation exige force: true', async () => {
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'expert', modules: '*' }) })).status, 200);
    assert.equal(licenseState().edition, 'expert');
    const refused = await post(port, '/api/license', { token: token({ edition: 'lite', modules: [] }) });
    assert.equal(refused.status, 409);
    const body = await refused.json() as { error: string; current: { edition: string }; next: { edition: string } };
    assert.equal(body.error, 'downgrade');
    assert.equal(body.current.edition, 'expert');
    assert.equal(body.next.edition, 'lite');
    assert.equal(licenseState().edition, 'expert');
    // Un module de moins est aussi une rétrogradation…
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'expert', modules: ['@timon/dreams'] }) })).status, 409);
    // …et force la fait passer.
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'lite', modules: [] }), force: true })).status, 200);
    assert.equal(licenseState().edition, 'lite');
    // Remonter ne demande rien.
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'expert', modules: '*' }) })).status, 200);
    setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
  });
});

test('L-1 : une activation réussie persiste la clé et le calendrier du serveur', async () => {
  const { readLicenseKey } = await import('./license/refresh.js');
  await withMockedLicenseServer(
    (_url, init) => signedAnswer(init, 200, { token: token(), refresh: { every: 120, offlineHours: 48 } }),
    () => withActivateServer(async (port) => {
      const response = await post(port, '/api/license/activate', { key: 'TMN-PERSIST' });
      assert.equal(response.status, 200);
      assert.equal(readLicenseKey(), 'TMN-PERSIST');
      const store = readLicenseStore();
      assert.equal(store.every, 120);
      assert.equal(store.offlineHours, 48);
      assert.ok(store.lastContact && store.lastContact >= now - 5);
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
    }),
  );
});

test('POST /api/license/activate refuse une clé manquante sans appeler le serveur', async () => {
  await withActivateServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/license/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'missing license key');
  });
});

test('POST /api/license/activate relaie le refus du serveur de licences', async () => {
  await withMockedLicenseServer(
    (_url, init) => signedAnswer(init, 409, { error: 'seat_limit', message: 'no seat left' }),
    () => withActivateServer(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/license/activate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TMN-TEST' }),
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, 'seat_limit');
      assert.equal(body.message, 'no seat left');
    }),
  );
});

test("POST /api/license/activate refuse un jeton que ce daemon ne reconnaît pas sans l'installer", async () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  const original = token();
  writeFileSync(file, original);
  // Réponse signée par la clé que le daemon épingle, mais jeton signé par une
  // autre : le serveur d'en face est authentique, le jeton non.
  const issued = signed(claims(), { kid: 'unknown' });
  await withMockedLicenseServer(
    (_url, init) => signedAnswer(init, 200, { token: issued }),
    () => withActivateServer(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/license/activate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TMN-TEST' }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).reason, 'invalid:key');
      assert.equal(readFileSync(file, 'utf8'), original);
    }),
  );
});

test('la clé de production épinglée est bien celle du JWKS publié', async () => {
  const { LICENSE_PUBLIC_KEYS } = await import('./license/pubkey.js');
  const { createPublicKey } = await import('node:crypto');
  const pinned = LICENSE_PUBLIC_KEYS.find((k) => k.keyId === 'license-2026-09');
  assert.ok(pinned, 'clé de production absente du registre');
  const jwk = createPublicKey(pinned.publicKey).export({ format: 'jwk' }) as { crv?: string; x?: string };
  assert.equal(jwk.crv, 'Ed25519');
  assert.equal(jwk.x, '5lx205PP0N9rtsGjKdJHBO0sv4IO5GtzwL62eP4LOwE');
});

/**
 * `POST /api/license/name` (PRD §5.10). The name is written once; what this
 * daemon can display afterwards is only what its own accepted write returned,
 * since neither the token nor the 409 carries it.
 */
test('POST /api/license/name records the accepted name and publishes it', async () => {
  const { writeLicenseKey, forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName } = await import('./license/store.js');
  forgetMachineName();
  setLicenseState(verifyLicenseToken(token(), { keys, device: DEVICE }));
  writeLicenseKey('TMN-NAME');
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 200, { ok: true, customName: 'atelier' }),
      () => withActivateServer(async (port) => {
        const response = await post(port, '/api/license/name', { name: '  atelier  ' });
        assert.equal(response.status, 200);
        const body = await response.json() as { machineName: string; machineNameLocked: boolean };
        assert.equal(body.machineName, 'atelier');
        assert.equal(body.machineNameLocked, true);
        // Survives a restart: the state file is the only place the name lives.
        assert.equal(readLicenseStore().machineName, 'atelier');
        // And `GET` says the same thing, since the page reads that one.
        const read = await (await fetch(`http://127.0.0.1:${port}/api/license`)).json() as { machineName: string };
        assert.equal(read.machineName, 'atelier');
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('POST /api/license/name relays 409 name_locked and stops offering the field', async () => {
  const { writeLicenseKey, forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName } = await import('./license/store.js');
  forgetMachineName();
  setLicenseState(verifyLicenseToken(token(), { keys, device: DEVICE }));
  writeLicenseKey('TMN-NAME');
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 409, { error: 'name_locked', message: 'This machine already has a name; a name is set once.' }),
      () => withActivateServer(async (port) => {
        const response = await post(port, '/api/license/name', { name: 'second try' });
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error: string }).error, 'name_locked');
        // §5.10 sends no name back, so none is stored — but the lock is, which
        // is what turns the form into a plain sentence.
        const store = readLicenseStore();
        assert.equal(store.machineNameLocked, true);
        assert.equal(store.machineName ?? null, null);
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('POST /api/license/name refuses an invalid name before any network call', async () => {
  const { writeLicenseKey, forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName } = await import('./license/store.js');
  forgetMachineName();
  setLicenseState(verifyLicenseToken(token(), { keys, device: DEVICE }));
  writeLicenseKey('TMN-NAME');
  let calls = 0;
  try {
    await withMockedLicenseServer(
      (_url, init) => { calls += 1; return signedAnswer(init, 200, { ok: true, customName: 'x' }); },
      () => withActivateServer(async (port) => {
        for (const name of ['', '   ', 'x'.repeat(33), 'line\nbreak', 42]) {
          const response = await post(port, '/api/license/name', { name });
          assert.equal(response.status, 400, `expected ${JSON.stringify(name)} to be refused`);
          assert.equal((await response.json() as { error: string }).error, 'invalid_name');
        }
        assert.equal(calls, 0);
        assert.equal(readLicenseStore().machineNameLocked ?? false, false);
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('POST /api/license/name is refused for a mission token, like its neighbours', async () => {
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license/name', { name: 'atelier' })).status, 403);
  }, { kind: 'api-token', isSuperadmin: true });
});

test('POST /api/license/name without an activation key never reaches the server', async () => {
  const { forgetLicenseKey } = await import('./license/refresh.js');
  forgetLicenseKey();
  await withActivateServer(async (port) => {
    const response = await post(port, '/api/license/name', { name: 'atelier' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, 'activation_key_missing');
  });
});

test('re-activating the SAME key keeps the machine name, another key drops it', async () => {
  const { forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 200, { token: token(), refresh: { every: 120, offlineHours: 48 } }),
      () => withActivateServer(async (port) => {
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-SAME' })).status, 200);
        writeLicenseStore({ machineName: 'atelier', machineNameLocked: true });
        // A repair — same key, re-activated. The name is not re-readable from
        // anywhere, so losing it here would lose it for good.
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-SAME' })).status, 200);
        assert.equal(readLicenseStore().machineName, 'atelier');
        // Another licence, another activation: its name is not this one's.
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-OTHER' })).status, 200);
        const store = readLicenseStore();
        assert.equal(store.machineName, null);
        assert.equal(store.machineNameLocked, false);
        setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('activating another key replaces the renewal key and drops the previous schedule', async () => {
  const { forgetLicenseKey, readLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  let refresh: { every: number; offlineHours: number } | undefined = { every: 120, offlineHours: 48 };
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 200, { token: token(), ...(refresh ? { refresh } : {}) }),
      () => withActivateServer(async (port) => {
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-FIRST' })).status, 200);
        writeLicenseStore({ machineName: 'atelier', machineNameLocked: true, machineNameLicense: 'lic_first' });
        refresh = undefined;
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-SECOND' })).status, 200);
        assert.equal(readLicenseKey(), 'TMN-SECOND');
        const store = readLicenseStore();
        assert.equal(store.machineName, null);
        assert.equal(store.machineNameLocked, false);
        assert.equal(store.machineNameLicense, null);
        assert.equal(store.every, undefined);
        assert.equal(store.offlineHours, undefined);
        assert.ok(store.lastContact && store.lastContact >= now - 5);
        setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('PUT /api/license forgets the previous licence\'s name and key, keeps them on the same licence', async () => {
  const { forgetLicenseKey, readLicenseKey, writeLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  try {
    await withActivateServer(async (port) => {
      // The shape a hand-pasted token actually arrives in: named under one
      // licence, and nothing valid installed any more — the token expired,
      // which is precisely why someone is pasting a fresher one. Comparing
      // against the LIVE state here would read every repair as a replacement.
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      writeLicenseStore({ machineName: 'atelier', machineNameLocked: true, machineNameLicense: claims().lic as string });
      writeLicenseKey('TMN-SAME');
      const repair = await post(port, '/api/license', { token: token({ jti: 'another-token' }) });
      assert.equal(repair.status, 200);
      const kept = await repair.json() as { machineName: string | null; machineNameLocked: boolean };
      assert.equal(kept.machineName, 'atelier');
      assert.equal(kept.machineNameLocked, true);
      assert.equal(readLicenseKey(), 'TMN-SAME');
      // Another licence, pasted from the same expired footing: the recorded
      // `lic` is the only thing that can tell it from the repair above.
      // Asserted on the ANSWER, not on the store — a forget that lands after
      // the response would still leave the old name on screen.
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      const replaced = await post(port, '/api/license', { token: token({ lic: 'lic_other' }) });
      assert.equal(replaced.status, 200);
      const body = await replaced.json() as { machineName: string | null; machineNameLocked: boolean };
      assert.equal(body.machineName, null);
      assert.equal(body.machineNameLocked, false);
      assert.equal(readLicenseStore().machineNameLocked, false);
      // The key renewed the licence that just left: keeping it would put its
      // token back over the one just installed.
      assert.equal(readLicenseKey(), null);
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
    });
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('PUT /api/license clears an unbound name and renewal key', async () => {
  const { forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  try {
    await withActivateServer(async (port) => {
      // Unknown provenance cannot keep a stale renewal key tied to the old licence.
      writeLicenseStore({ machineName: 'atelier', machineNameLocked: true });
      const response = await post(port, '/api/license', { token: token({ lic: 'lic_yet_another' }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { machineName: string | null }).machineName, null);
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
    });
  } finally { forgetLicenseKey(); forgetMachineName(); }
});
