import assert from 'node:assert/strict';
import test from 'node:test';
import { encodedMimeTypes } from './browser-media-formats';

const MP4_OPUS = 'video/mp4;codecs=avc1.42E01E,opus';
const MP4_AAC = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
const MP4_VIDEO = 'video/mp4;codecs=avc1.42E01E';

test('an MP4-only viewer offers MP4 with Opus before AAC, then the silent fallback', () => {
  const mp4Only = (type: string) => type.startsWith('video/mp4');
  assert.deepEqual(encodedMimeTypes(true, mp4Only), [MP4_OPUS, MP4_AAC, MP4_VIDEO]);
});

test('a viewer that plays no MP4 audio codec still offers video-only MP4 instead of nothing', () => {
  assert.deepEqual(encodedMimeTypes(true, (type) => type === MP4_VIDEO), [MP4_VIDEO]);
});

test('a viewer without Opus in MP4 keeps AAC, so a host with an AAC encoder still sends sound', () => {
  assert.deepEqual(encodedMimeTypes(true, (type) => type.startsWith('video/mp4') && type !== MP4_OPUS), [MP4_AAC, MP4_VIDEO]);
});

test('every audio format is offered before any video-only one', () => {
  const offered = encodedMimeTypes(true, () => true);
  const firstSilent = offered.findIndex((type) => !/opus|mp4a/.test(type));
  assert.ok(firstSilent > 0);
  assert.ok(offered.slice(firstSilent).every((type) => !/opus|mp4a/.test(type)));
});

test('without sound requested, no audio codec is offered', () => {
  assert.ok(encodedMimeTypes(false, () => true).every((type) => !/opus|mp4a/.test(type)));
  assert.deepEqual(encodedMimeTypes(false, () => false), []);
});
