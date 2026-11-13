import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mediaPage } from './native-browser-media-page.js';

const MP4_OPUS = 'video/mp4;codecs=avc1.42E01E,opus';
const MP4_AAC = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
const MP4_VIDEO = 'video/mp4;codecs=avc1.42E01E';
const WEBM_OPUS = 'video/webm;codecs=vp8,opus';

type Track = { kind: string; stop(): void; onended?: () => void };
type Started = { mimeType: string; audio: boolean };

/** Runs the capture page's script against a fake recorder that encodes only `encodable`. */
async function start(encodable: string[], viewer: string[] | null, audio = true) {
  const script = /<script>([\s\S]*)<\/script>/.exec(mediaPage)?.[1];
  assert.ok(script);
  const tracks: Track[] = [{ kind: 'video', stop() {} }, ...(audio ? [{ kind: 'audio', stop() {} }] : [])];
  class FakeStream {
    constructor(readonly list: Track[] = tracks) {}
    getTracks() { return this.list; }
    getVideoTracks() { return this.list.filter((track) => track.kind === 'video'); }
    getAudioTracks() { return this.list.filter((track) => track.kind === 'audio'); }
  }
  const recorders: Array<{ stream: FakeStream; mimeType: string }> = [];
  class FakeRecorder {
    static isTypeSupported(type: string) { return encodable.includes(type); }
    state = 'inactive'; mimeType: string;
    constructor(readonly stream: FakeStream, options: { mimeType: string }) { this.mimeType = options.mimeType; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  }
  const window: Record<string, unknown> = {};
  runInNewContext(script, {
    window, MediaRecorder: FakeRecorder, MediaStream: FakeStream, setTimeout, clearTimeout,
    navigator: { mediaDevices: { getDisplayMedia: async () => new FakeStream() } },
  });
  const media = window.rooksMedia as { start(audio: boolean, offer: null, viewer: string[] | null, width: number, height: number): Promise<Started> };
  const result = await media.start(audio, null, viewer, 640, 480);
  return { result, recorded: recorders[0]!.stream };
}

test('a Linux host without AAC records MP4 with Opus for an MP4-only viewer', async () => {
  const { result, recorded } = await start([WEBM_OPUS, MP4_OPUS, MP4_VIDEO], [MP4_OPUS, MP4_AAC, MP4_VIDEO]);
  assert.deepEqual({ ...result }, { mimeType: MP4_OPUS, audio: true });
  assert.equal(recorded.getAudioTracks().length, 1);
});

test('a host with an AAC encoder still serves a viewer that cannot play Opus in MP4', async () => {
  const { result } = await start([MP4_OPUS, MP4_AAC, MP4_VIDEO], [MP4_AAC, MP4_VIDEO]);
  assert.deepEqual({ ...result }, { mimeType: MP4_AAC, audio: true });
});

test('no shared audio format falls back to silent video and drops the audio track from the recorder', async () => {
  const { result, recorded } = await start([MP4_VIDEO], [MP4_AAC, MP4_VIDEO]);
  assert.deepEqual({ ...result }, { mimeType: MP4_VIDEO, audio: false });
  assert.equal(recorded.getAudioTracks().length, 0);
  assert.equal(recorded.getVideoTracks().length, 1);
});

test('WebM with Opus stays the first choice when both sides support it', async () => {
  const { result } = await start([WEBM_OPUS, MP4_OPUS, MP4_VIDEO], null);
  assert.equal(result.mimeType, WEBM_OPUS);
});

test('nothing in common is still an error', async () => {
  await assert.rejects(start([WEBM_OPUS], [MP4_AAC, MP4_VIDEO]), /not supported/);
});
