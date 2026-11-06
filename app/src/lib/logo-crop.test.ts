import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampOffset,
  clampZoom,
  containZoom,
  coverScale,
  drawRect,
  initialCrop,
  LOGO_OUTPUT_PX,
  MAX_LOGO_ZOOM,
  MIN_LOGO_ZOOM,
  normalizeCrop,
  DEFAULT_CROP,
} from './logo-crop';

const WIDE = { width: 800, height: 400 };
const SQUARE = { width: 512, height: 512 };

test('cover scale fills the square from the shortest side', () => {
  assert.equal(coverScale(WIDE), LOGO_OUTPUT_PX / 400);
  assert.equal(coverScale(SQUARE), 0.5);
});

test('at zoom 1 a square source lands exactly on the frame', () => {
  const rect = drawRect(SQUARE, DEFAULT_CROP);
  assert.deepEqual(rect, { x: 0, y: 0, width: LOGO_OUTPUT_PX, height: LOGO_OUTPUT_PX });
});

test('a wide source is centred, overflowing left and right only', () => {
  const rect = drawRect(WIDE, DEFAULT_CROP);
  assert.equal(rect.height, LOGO_OUTPUT_PX);
  assert.equal(rect.y, 0);
  assert.ok(rect.width > LOGO_OUTPUT_PX);
  assert.equal(rect.x, (LOGO_OUTPUT_PX - rect.width) / 2);
});

test('panning stops where a gap would appear', () => {
  // A square source at zoom 1 has no slack at all: it cannot be moved.
  assert.deepEqual(clampOffset(SQUARE, { ...DEFAULT_CROP, offsetX: 80, offsetY: -50 }), {
    offsetX: 0,
    offsetY: 0,
  });
  // A wide one can slide horizontally, up to half its overflow.
  const slackX = (WIDE.width * coverScale(WIDE) - LOGO_OUTPUT_PX) / 2;
  assert.deepEqual(clampOffset(WIDE, { ...DEFAULT_CROP, offsetX: 9999, offsetY: 9999 }), {
    offsetX: slackX,
    offsetY: 0,
  });
});

test('zooming in unlocks panning in both directions', () => {
  const zoomed = { ...DEFAULT_CROP, zoom: 2, offsetX: 9999, offsetY: 9999 };
  const { offsetX, offsetY } = clampOffset(SQUARE, zoomed);
  assert.equal(offsetX, LOGO_OUTPUT_PX / 2);
  assert.equal(offsetY, LOGO_OUTPUT_PX / 2);
});

test('zoom stays inside the slider range, which goes below cover', () => {
  assert.equal(clampZoom(0.5), 0.5);
  assert.equal(clampZoom(0.01), MIN_LOGO_ZOOM);
  assert.equal(clampZoom(99), MAX_LOGO_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
});

test('a wide logo can shrink until it fits whole inside the frame', () => {
  const zoom = containZoom(WIDE);
  const rect = drawRect(WIDE, { ...DEFAULT_CROP, zoom });
  assert.equal(rect.width, LOGO_OUTPUT_PX);
  assert.ok(rect.height < LOGO_OUTPUT_PX);
  assert.equal(rect.x, 0);
});

test('an image smaller than the frame can still be positioned inside it', () => {
  const crop = { ...DEFAULT_CROP, zoom: containZoom(WIDE), offsetX: 0, offsetY: 9999 };
  const { offsetY } = clampOffset(WIDE, crop);
  const drawn = drawRect(WIDE, { ...crop, offsetY: 0 });
  // It stops once its edge touches the frame's, not at the centre.
  assert.equal(offsetY, (LOGO_OUTPUT_PX - drawn.height) / 2);
});

test('a transparent logo starts whole with a little air, a photo starts full bleed', () => {
  assert.equal(initialCrop(SQUARE, false).zoom, 1);
  const logo = initialCrop(WIDE, true);
  assert.ok(logo.zoom < containZoom(WIDE));
  assert.ok(logo.zoom > containZoom(WIDE) * 0.8);
});

test('normalizing clamps zoom first, then the offset that zoom allows', () => {
  const crop = normalizeCrop(SQUARE, { zoom: 0.01, offsetX: 9999, offsetY: 0, background: '#fff' });
  assert.equal(crop.zoom, MIN_LOGO_ZOOM, 'below the slider floor');
  // At that zoom the image is tiny, so it may travel almost to the edge.
  const drawn = LOGO_OUTPUT_PX * MIN_LOGO_ZOOM;
  assert.equal(crop.offsetX, (LOGO_OUTPUT_PX - drawn) / 2);
  assert.equal(crop.background, '#fff');
});

test('the preview size scales the whole framing', () => {
  const full = drawRect(WIDE, { ...DEFAULT_CROP, zoom: 1.5 }, LOGO_OUTPUT_PX);
  const half = drawRect(WIDE, { ...DEFAULT_CROP, zoom: 1.5 }, LOGO_OUTPUT_PX / 2);
  assert.equal(half.width, full.width / 2);
  assert.equal(half.x, full.x / 2);
});
