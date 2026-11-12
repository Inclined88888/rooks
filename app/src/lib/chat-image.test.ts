import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_IMAGE_JPEG_QUALITY,
  compressForChat,
  fitWithin,
  hasTransparency,
  type ChatImageCodec,
} from './chat-image';

type Call = { width: number; height: number; type?: string; quality?: number; closed: boolean };

/** A codec that records what it was asked and answers with `outBytes` bytes. */
function fakeCodec(opts: { width: number; height: number; alpha?: boolean; outBytes?: number; decodable?: boolean }) {
  const call: Call = { width: 0, height: 0, closed: false };
  const codec: ChatImageCodec = {
    async load() {
      if (opts.decodable === false) return null;
      return {
        width: opts.width,
        height: opts.height,
        render(width, height) {
          call.width = width;
          call.height = height;
          return {
            hasAlpha: () => opts.alpha === true,
            async encode(type, quality) {
              call.type = type;
              call.quality = quality;
              return new Blob([new Uint8Array(opts.outBytes ?? 1000)], { type });
            },
          };
        },
        close() { call.closed = true; },
      };
    },
  };
  return { codec, call };
}

const file = (bytes: number, type: string) => new File([new Uint8Array(bytes)], 'x', { type });

test('the longest side is brought down to 2048 px, ratio kept, never enlarged', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 2048, height: 1536 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1536, height: 2048 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(10000, 1), { width: 2048, height: 1 });
});

test('transparency is any alpha byte below 255', () => {
  assert.equal(hasTransparency([1, 2, 3, 255, 4, 5, 6, 255]), false);
  assert.equal(hasTransparency([1, 2, 3, 255, 4, 5, 6, 254]), true);
});

test('a phone photo becomes a 2048 px JPEG at q 0.85', async () => {
  const { codec, call } = fakeCodec({ width: 4032, height: 3024, outBytes: 400_000 });
  const out = await compressForChat(file(3_000_000, 'image/jpeg'), codec);
  assert.equal(out.mediaType, 'image/jpeg');
  assert.equal(out.blob.size, 400_000);
  assert.deepEqual([call.width, call.height], [2048, 1536]);
  assert.equal(call.quality, CHAT_IMAGE_JPEG_QUALITY);
  assert.equal(call.closed, true);
});

test('a PNG stays PNG only when it really uses transparency', async () => {
  const opaque = fakeCodec({ width: 3000, height: 2000, alpha: false });
  assert.equal((await compressForChat(file(5_000_000, 'image/png'), opaque.codec)).mediaType, 'image/jpeg');

  const transparent = fakeCodec({ width: 3000, height: 2000, alpha: true });
  const out = await compressForChat(file(5_000_000, 'image/png'), transparent.codec);
  assert.equal(out.mediaType, 'image/png');
  assert.equal(transparent.call.quality, undefined);
});

test('a small image the re-encode would make heavier is sent as it was', async () => {
  const { codec } = fakeCodec({ width: 600, height: 400, outBytes: 90_000 });
  const original = file(50_000, 'image/png');
  const out = await compressForChat(original, codec);
  assert.equal(out.blob, original);
  assert.equal(out.mediaType, 'image/png');
});

test('an image the browser cannot decode, or a failing encode, keeps the original', async () => {
  const heic = file(2_000_000, 'image/heic');
  const undecodable = fakeCodec({ width: 1, height: 1, decodable: false });
  assert.equal((await compressForChat(heic, undecodable.codec)).blob, heic);

  const broken: ChatImageCodec = {
    async load() {
      return {
        width: 4000,
        height: 3000,
        render() { throw new Error('canvas 2d unavailable'); },
        close() {},
      };
    },
  };
  const photo = file(3_000_000, 'image/jpeg');
  assert.equal((await compressForChat(photo, broken)).blob, photo);
});
