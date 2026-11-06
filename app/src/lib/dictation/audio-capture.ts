import { Chunker, Resampler } from './resample';

/**
 * Microphone capture for the local dictation engine: `getUserMedia`, an
 * AudioWorklet that downmixes to mono, then the resampler and the chunker.
 * `ScriptProcessorNode` is deprecated and runs on the main thread, where a
 * busy render would drop audio; the worklet runs on the audio thread and only
 * posts blocks.
 */

/** Web Speech's own codes, so both surfaces already treat them as fatal. */
export type CaptureErrorCode = 'not-allowed' | 'audio-capture';

export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message: string) {
    super(message);
  }
}

/** `getUserMedia` rejections, by DOMException name. */
export function captureErrorCode(error: unknown): CaptureErrorCode {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String((error as { name: unknown }).name) : '';
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'not-allowed' : 'audio-capture';
}

export type CaptureHandlers = {
  /** 16 kHz mono chunks, 100 ms each. */
  onChunk(samples: Float32Array): void;
  /** The device went away mid-capture (unplugged, disabled, taken by the OS). */
  onDeviceLost(): void;
};

export type MicrophoneCapture = {
  /** Stops the device and returns what the chunker still held (< 100 ms). */
  stop(): Float32Array | null;
};

const PROCESSOR = 'timon-dictation-capture';

/** Runs on the audio thread: mono downmix, posted in ~40 ms blocks. */
const WORKLET_SOURCE = `
class TimonDictationCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(2048); this.filled = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const frames = channels[0].length;
      for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < channels.length; c += 1) sum += channels[c][i];
        this.block[this.filled] = sum / channels.length;
        this.filled += 1;
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(2048);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR}', TimonDictationCapture);
`;

async function loadWorklet(context: AudioContext): Promise<void> {
  // A Blob URL keeps the processor in this module: no file to serve from
  // public/, nothing for the packaged app to miss.
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function startMicrophoneCapture(handlers: CaptureHandlers): Promise<MicrophoneCapture> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
    throw new CaptureError('audio-capture', 'no microphone API in this window');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw new CaptureError(captureErrorCode(error), error instanceof Error ? error.message : 'getUserMedia failed');
  }

  const context = new AudioContext();
  let stopped = false;
  const resampler = new Resampler(context.sampleRate);
  const chunker = new Chunker();
  const tracks = stream.getAudioTracks();

  const release = () => {
    stopped = true;
    for (const track of stream.getTracks()) {
      track.removeEventListener('ended', onEnded);
      track.stop();
    }
    if (context.state !== 'closed') void context.close();
  };
  function onEnded() {
    if (stopped) return;
    release();
    handlers.onDeviceLost();
  }

  try {
    await loadWorklet(context);
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = (message: MessageEvent<unknown>) => {
      if (stopped || !(message.data instanceof Float32Array)) return;
      for (const chunk of chunker.push(resampler.push(message.data))) handlers.onChunk(chunk);
    };
    // A silent sink: Chromium only pulls a node that leads to the destination.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
  } catch (error) {
    release();
    throw new CaptureError('audio-capture', error instanceof Error ? error.message : 'audio graph failed');
  }

  for (const track of tracks) track.addEventListener('ended', onEnded);
  // Unplugged between getUserMedia and here: `ended` already fired.
  if (tracks.length === 0 || tracks.some((track) => track.readyState === 'ended')) {
    onEnded();
  }

  return {
    stop() {
      if (stopped) return null;
      release();
      return chunker.flush();
    },
  };
}
