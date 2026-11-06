/**
 * Formats the recorder may produce, best first; the viewer's list
 * (app/src/lib/browser-media-formats.ts) is ordered the same way.
 */
export const recorderAudioTypes = [
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus',
  // Chromium has no AAC encoder on Linux: MP4 with Opus is the only MP4 a Linux host records with sound.
  'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
];
export const recorderVideoTypes = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4;codecs=avc1.42E01E'];

/** Trusted capture renderer. It never loads websites or receives profile credentials. */
export const mediaPage = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; media-src blob:; connect-src 'none'">
<title>Timon browser transport</title><script>
(() => {
  let stream, recorder, peer, failure = null, ended = false, sequence = 0;
  let queue = [], queued = 0, pendingBlobBytes = 0, blobs = Promise.resolve();
  const limit = 8 * 1024 * 1024;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const iceComplete = pc => new Promise((resolve, reject) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', changed); reject(new Error('ICE gathering timed out')); }, 7000);
    const changed = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); resolve(); } };
    pc.addEventListener('icegatheringstatechange', changed);
  });
  const stop = () => {
    ended = true;
    if (recorder?.state === 'recording') recorder.stop();
    peer?.close();
    stream?.getTracks().forEach(track => track.stop());
    queue = []; queued = 0;
  };
  window.timonMedia = {
    async start(audio, offer, supportedMimeTypes, width, height) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 30 }, width: { max: width }, height: { max: height } }, audio
      });
      for (const track of stream.getTracks()) track.onended = () => { failure = 'Browser capture ended'; stop(); };
      if (offer) {
        peer = new RTCPeerConnection({ iceServers: [] });
        for (const track of stream.getTracks()) {
          const sender = peer.addTrack(track, stream);
          if (track.kind === 'video') {
            const parameters = sender.getParameters();
            parameters.encodings = [{ maxBitrate: 3000000, maxFramerate: 30 }];
            await sender.setParameters(parameters).catch(() => {});
          }
        }
        await peer.setRemoteDescription(offer);
        await peer.setLocalDescription(await peer.createAnswer());
        await iceComplete(peer);
        return { answer: { type: peer.localDescription.type, sdp: peer.localDescription.sdp }, audio: stream.getAudioTracks().length > 0 };
      }
      const accepted = type => (!supportedMimeTypes || supportedMimeTypes.includes(type)) && MediaRecorder.isTypeSupported(type);
      let mimeType = audio ? ${JSON.stringify(recorderAudioTypes)}.find(accepted) : undefined;
      let recorded = stream;
      if (!mimeType) {
        // No audio format both sides share: a silent picture beats an error, and the
        // recorder must not be handed an audio track its container cannot carry.
        mimeType = ${JSON.stringify(recorderVideoTypes)}.find(accepted);
        if (mimeType && stream.getAudioTracks().length) recorded = new MediaStream(stream.getVideoTracks());
      }
      if (!mimeType) { stop(); throw new Error('An encoded browser stream is not supported by this runtime'); }
      recorder = new MediaRecorder(recorded, { mimeType, videoBitsPerSecond: 2500000, audioBitsPerSecond: 96000 });
      recorder.onerror = event => { failure = event.error?.message || 'Browser encoder failed'; stop(); };
      recorder.ondataavailable = event => {
        if (!event.data.size || ended) return;
        const size = event.data.size;
        if (queued + pendingBlobBytes + size > limit) { failure = 'Browser stream receiver is too slow; reconnect to resume'; stop(); return; }
        pendingBlobBytes += size;
        blobs = blobs.then(async () => {
          try {
          if (ended) return;
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          if (ended) return;
          for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
            const part = bytes.slice(offset, offset + 128 * 1024);
            queue.push(part); queued += part.length;
          }
          } finally { pendingBlobBytes -= size; }
        }).catch(error => { failure = error.message; stop(); });
      };
      recorder.start(120);
      return { mimeType: recorder.mimeType, audio: recorded.getAudioTracks().length > 0 };
    },
    async read() {
      for (let i = 0; i < 10 && !queue.length && !ended; i++) await wait(40);
      if (failure) throw new Error(failure);
      const bytes = queue.shift();
      if (!bytes) return { data: '', sequence, eof: ended };
      queued -= bytes.length;
      let binary = '';
      for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return { data: btoa(binary), sequence: sequence++, eof: false };
    },
    stop,
    state: () => ({ ended, failure, queued, pendingBlobBytes, connection: peer?.connectionState ?? null })
  };
})();
</script>`;
