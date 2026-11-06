import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { bus, type BusEvent } from './bus.js';
import { createBrowserProfile } from './browser-profiles.js';
import {
  deleteBrowserAnnotation, findBrowserAnnotationByRef, getBrowserAnnotation, listBrowserAnnotations, listMissionAnnotations,
  MAX_ANNOTATIONS_PER_OWNER, missionAnnotationView, missionMayReachAnnotation, missionAnnotationProfile, ownerAnnotationView,
  picksOf, purgeBrowserAnnotations, readBrowserAnnotation, readBrowserAnnotationThumbnail, resolveBrowserAnnotation,
  saveBrowserAnnotations, sendBrowserAnnotations, setBrowserAnnotationComment, setBrowserAnnotationExternalRef,
  THUMBNAIL_BUDGET_PER_OWNER,
} from './browser-annotations.js';
import { resolveMasterKey } from './secrets/key.js';

resolveMasterKey({ keyring: null });
const COMMENT = 'make-this-button-bigger-comment-marker';
const PAGE_TEXT = 'checkout-page-text-marker';
const TITLE = 'shop-title-marker';
const SOURCE = 'src/Checkout.tsx';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64');

const cwd = mkdtempSync(join(tmpdir(), 'ann-cwd-'));
mkdirSync(join(cwd, 'src'));
writeFileSync(join(cwd, 'src', 'Checkout.tsx'), 'export {}');

const pick = (url = 'http://localhost:5173/checkout?token=abc', extra: Record<string, unknown> = {}) => ({
  version: 1, id: 'desktop-id', capturedAt: new Date().toISOString(), tabId: 't1', url, title: TITLE,
  point: { x: 10, y: 10 }, rect: { x: 0, y: 0, width: 80, height: 20 }, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
  target: { selector: '#pay', xpath: '/html[1]/body[1]/button[1]', tag: 'button', role: 'button', name: 'Pay', text: PAGE_TEXT,
    inputType: '', id: 'pay', classes: ['btn'], locators: [] },
  outerHtml: `<button id="pay">${PAGE_TEXT}</button>`, outerHtmlTruncated: false,
  source: { detected: true, framework: 'react', via: 'debugSource', file: join(cwd, SOURCE), line: 3, column: 2, component: 'Checkout' },
  thumbnail: { mimeType: 'image/jpeg', data: JPEG, width: 80, height: 20 },
  ...extra,
});
const owner = () => randomUUID();
const user = (id: string) => ({ kind: 'user' as const, id });
const events: Extract<BusEvent, { kind: 'browser_annotation' }>[] = [];
bus.on('event', (ev: BusEvent) => { if (ev.kind === 'browser_annotation') events.push(ev); });

function mission(agent: string, ownerUserId: string, profileId: string | null): ReturnType<typeof dbApi.getMission> & object {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'test', undefined, ownerUserId);
  if (profileId) dbApi.setMissionBrowserProfile(id, profileId);
  return dbApi.getMission(id)!;
}

test('the clear text of an annotation is not in plugin_kv: only sealed envelopes and bounded metadata', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Annotated', owner_user_id: ownerId });
  const { annotations: [meta] } = saveBrowserAnnotations(profile, [pick()], user(ownerId));
  assert.ok(meta);
  setBrowserAnnotationComment(meta, COMMENT, user(ownerId));
  const rows = dbApi.pluginKvList('@timon/browser-embedded').filter(({ key }) => key.endsWith(meta.id));
  assert.equal(rows.length, 3);
  assert.ok(rows.filter(({ key }) => key.startsWith('@settings/')).every(({ value }) => value.startsWith('enc:1:')));
  const everything = JSON.stringify(dbApi.pluginKvList('@timon/browser-embedded'));
  for (const marker of [COMMENT, PAGE_TEXT, TITLE, 'Checkout.tsx', 'localhost:5173', JPEG.slice(0, 40)]) {
    assert.ok(!everything.includes(marker), `${marker} is stored in clear`);
  }
  assert.equal(readBrowserAnnotation(getBrowserAnnotation(meta.id)!).comment, COMMENT);
  assert.equal(readBrowserAnnotationThumbnail(getBrowserAnnotation(meta.id)!)?.data, JPEG);
  assert.ok(events.length >= 2);
  assert.ok(!JSON.stringify(events).includes(COMMENT) && !JSON.stringify(events).includes(PAGE_TEXT), 'events carry metadata only');
  assert.deepEqual(listBrowserAnnotations({ ownerUserId: ownerId }).map((row) => row.id), [meta.id]);
  assert.deepEqual(listBrowserAnnotations({ ownerUserId: 'someone-else' }), []);
});

test('picks are capped per owner, thumbnails by a budget, and an invalid pick is refused', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Many', owner_user_id: ownerId });
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(150 * 1024)]).toString('base64');
  const heavy = pick(undefined, { thumbnail: { mimeType: 'image/jpeg', data: big, width: 800, height: 600 } });
  const fit = Math.floor(THUMBNAIL_BUDGET_PER_OWNER / Buffer.byteLength(big, 'base64'));
  const first = saveBrowserAnnotations(profile, [...Array.from({ length: fit + 2 }, () => heavy), { version: 1 }], user(ownerId));
  assert.equal(first.annotations.length, fit + 2);
  assert.equal(first.refused, 1);
  assert.equal(first.thumbnailsDropped, 2);
  assert.equal(first.annotations.at(-1)!.hasThumbnail, false);
  const rest = saveBrowserAnnotations(profile, Array.from({ length: MAX_ANNOTATIONS_PER_OWNER }, () => pick(undefined, { thumbnail: undefined })), user(ownerId));
  assert.equal(rest.annotations.length, MAX_ANNOTATIONS_PER_OWNER - fit - 2);
  assert.equal(rest.refused, fit + 2);
});

test('a capture queued from the desktop bubble keeps its id and its comment, once (TODO #481)', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Bubble', owner_user_id: ownerId });
  const id = randomUUID();
  const queued = pick(undefined, { id, comment: `  ${COMMENT}\r\nsecond line\u0007  ` });
  const { annotations: [meta], refused } = saveBrowserAnnotations(profile, [queued, queued], user(ownerId));
  assert.equal(meta?.id, `ba-${id}`);
  assert.equal(meta?.status, 'draft');
  assert.equal(refused, 1, 'the same capture twice in one answer is stored once');
  assert.equal(readBrowserAnnotation(meta!).comment, `${COMMENT}\nsecond line`);
  assert.equal(saveBrowserAnnotations(profile, [queued], user(ownerId)).refused, 1, 'a capture already stored is refused');
  assert.ok(!JSON.stringify(dbApi.pluginKvList('@timon/browser-embedded')).includes(COMMENT), 'the bubble comment is sealed');
  // Anything but a UUID names nothing: the store mints its own id, and a non-string comment is none.
  const [other] = saveBrowserAnnotations(profile, [pick(undefined, { id: '../ba-x', comment: 42 })], user(ownerId)).annotations;
  assert.match(other!.id, /^ba-[0-9a-f-]{36}$/);
  assert.notEqual(other!.id, 'ba-../ba-x');
  assert.equal(readBrowserAnnotation(other!).comment, '');
});

test('picksOf reads the three desktop answers', () => {
  assert.equal(picksOf({ annotation: { active: false, picks: [pick(), pick()] } }).length, 2);
  assert.equal(picksOf({ annotation: pick() }).length, 1);
  assert.deepEqual(picksOf({ hover: { rect: {} } }), []);
  assert.deepEqual(picksOf(null), []);
});

test('sending fixes the comment, checks the source path against the cwd, and reaches only the addressed mission', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Send', owner_user_id: ownerId });
  const other = createBrowserProfile({ name: 'Other', owner_user_id: ownerId });
  const saved = saveBrowserAnnotations(profile, [pick(), pick('https://shop.example/cart')], user(ownerId)).annotations;
  const annotations = [setBrowserAnnotationComment(saved[0]!, COMMENT, user(ownerId)), saved[1]!];
  const target = mission('ann-dev', ownerId, profile.id);
  assert.throws(() => sendBrowserAnnotations([], { missionId: target.id, agentName: 'ann-dev', cwd }, user(ownerId)), /between 1/);
  const sent = sendBrowserAnnotations(annotations, { missionId: target.id, agentName: 'ann-dev', cwd }, user(ownerId));
  assert.match(sent.batchId, /^bab-/);
  assert.ok(sent.annotations.every((meta) => meta.status === 'pending' && meta.delivery?.batchId === sent.batchId));
  const [local, outside] = sent.annotations as [typeof sent.annotations[0], typeof sent.annotations[0]];
  assert.throws(() => setBrowserAnnotationComment(local, 'changed', user(ownerId)), /already sent/);
  assert.throws(() => sendBrowserAnnotations([local], { missionId: target.id, agentName: null, cwd }, user(ownerId)), /already sent/);
  assert.deepEqual(ownerAnnotationView(local).source, { detected: true, framework: 'react', via: 'debugSource', component: 'Checkout', file: SOURCE, line: 3, column: 2 });

  const profileOf = missionAnnotationProfile(target);
  assert.equal(missionMayReachAnnotation(local, target, profileOf), true);
  assert.deepEqual(listMissionAnnotations(target, { batchId: sent.batchId }).map((meta) => meta.id), [local.id, outside.id]);
  const sameAgentOtherMission = mission('ann-dev', ownerId, profile.id);
  assert.equal(missionMayReachAnnotation(local, sameAgentOtherMission, missionAnnotationProfile(sameAgentOtherMission)), false, 'sent to one mission');
  const otherOwner = mission('ann-dev', owner(), profile.id);
  assert.equal(missionMayReachAnnotation(local, otherOwner, missionAnnotationProfile(otherOwner)), false);
  const otherProfile = mission('ann-dev', ownerId, other.id);
  assert.equal(missionMayReachAnnotation(local, otherProfile, missionAnnotationProfile(otherProfile)), false, 'another browser profile');

  const view = missionAnnotationView(local, cwd);
  assert.equal(view.comment, COMMENT);
  assert.equal(view.page.target.text, PAGE_TEXT);
  assert.equal(view.page.textWithheld, false);
  assert.equal(view.source.detected && view.source.file, SOURCE);
  const elsewhere = missionAnnotationView(local, mkdtempSync(join(tmpdir(), 'ann-elsewhere-')));
  assert.ok(elsewhere.source.detected && elsewhere.source.file === null && elsewhere.source.line === undefined, 'no path outside the reader\'s cwd');
  const foreign = missionAnnotationView(outside, cwd);
  assert.equal(foreign.page.textWithheld, true);
  assert.equal(foreign.page.target.text, '');
  assert.equal(foreign.page.target.name, '');
  assert.equal(foreign.page.title, '');
  assert.equal(foreign.page.outerHtml, '');
  assert.ok(foreign.page.target.locators.every((locator) => locator.kind === 'css' || locator.kind === 'xpath'));
});

test('a batch sent to an agent reaches that agent\'s missions only', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Agent', owner_user_id: ownerId });
  const { annotations: [meta] } = saveBrowserAnnotations(profile, [pick()], user(ownerId));
  const { annotations: [sent] } = sendBrowserAnnotations([meta!], { missionId: null, agentName: 'ann-front', cwd: null }, user(ownerId));
  assert.equal(ownerAnnotationView(sent!).source.detected && ownerAnnotationView(sent!).source.file, null, 'no cwd, no path');
  const front = mission('ann-front', ownerId, profile.id);
  const back = mission('ann-back', ownerId, profile.id);
  assert.equal(missionMayReachAnnotation(sent!, front, missionAnnotationProfile(front)), true);
  assert.equal(missionMayReachAnnotation(sent!, back, missionAnnotationProfile(back)), false);
  const draft = saveBrowserAnnotations(profile, [pick()], user(ownerId)).annotations[0]!;
  assert.equal(missionMayReachAnnotation(draft, front, missionAnnotationProfile(front)), false, 'a draft reaches nobody');
});

test('resolve and dismiss record their note once, and the retention purges them sooner', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Resolve', owner_user_id: ownerId });
  const now = Date.now();
  const { annotations } = saveBrowserAnnotations(profile, [pick(), pick(), pick()], user(ownerId), now);
  const agent = { kind: 'agent' as const, id: 'ann-dev' };
  const done = resolveBrowserAnnotation(annotations[0]!, { status: 'resolved', note: 'Bigger padding in Checkout.tsx' }, agent, now);
  assert.equal(done.status, 'resolved');
  assert.deepEqual(done.resolvedBy, agent);
  assert.deepEqual(ownerAnnotationView(done).resolution, { status: 'resolved', summary: 'Bigger padding in Checkout.tsx' });
  assert.throws(() => resolveBrowserAnnotation(done, { status: 'dismissed', note: 'x' }, agent), /already resolved/);
  const dismissed = resolveBrowserAnnotation(annotations[1]!, { status: 'dismissed', note: 'Not reproducible' }, agent, now);
  assert.deepEqual(ownerAnnotationView(dismissed).resolution, { status: 'dismissed', reason: 'Not reproducible' });

  const day = 86_400_000;
  assert.equal(purgeBrowserAnnotations(7, 1, now + day / 2).deleted >= 0, true);
  assert.ok(getBrowserAnnotation(done.id));
  purgeBrowserAnnotations(7, 1, now + day + 1);
  assert.equal(getBrowserAnnotation(done.id), undefined, 'a resolved annotation goes after a day');
  assert.equal(getBrowserAnnotation(dismissed.id), undefined);
  assert.ok(getBrowserAnnotation(annotations[2]!.id), 'an open one stays');
  purgeBrowserAnnotations(0, 1, now + 30 * day);
  assert.ok(getBrowserAnnotation(annotations[2]!.id), 'a retention of 0 keeps open annotations');
  purgeBrowserAnnotations(7, 1, now + 7 * day + 10);
  assert.equal(getBrowserAnnotation(annotations[2]!.id), undefined);
  assert.equal(dbApi.pluginKvList('@timon/browser-embedded').some(({ key }) => key.endsWith(annotations[2]!.id)), false, 'sealed rows go too');
  assert.equal(events.at(-1)?.event, 'purged');
  assert.equal(events.at(-1)?.reason, 'retention');
});

test('an external reference links one annotation at a time', () => {
  const ownerId = owner();
  const profile = createBrowserProfile({ name: 'Ref', owner_user_id: ownerId });
  const { annotations: [a, b] } = saveBrowserAnnotations(profile, [pick(), pick()], user(ownerId));
  const ref = { provider: 'github', ref: 'acme/web#12', url: 'https://github.com/acme/web/issues/12' };
  setBrowserAnnotationExternalRef(a!, ref, { kind: 'plugin', id: 'acme' });
  assert.equal(findBrowserAnnotationByRef('github', 'acme/web#12')?.id, a!.id);
  assert.throws(() => setBrowserAnnotationExternalRef(b!, ref, { kind: 'plugin', id: 'acme' }), /already linked/);
  assert.throws(() => setBrowserAnnotationExternalRef(b!, { provider: 'x', ref: 'y', url: 'javascript:alert(1)' }, { kind: 'plugin', id: 'acme' }), /invalid/);
  deleteBrowserAnnotation(getBrowserAnnotation(a!.id)!, user(ownerId));
  assert.equal(findBrowserAnnotationByRef('github', 'acme/web#12'), undefined);
});
