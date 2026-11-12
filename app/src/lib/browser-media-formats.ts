/**
 * Encoded-stream formats the viewer offers to the capture host, best first.
 * The host (desktop/src/native-browser-media-page.ts) keeps the same lists:
 * it records the first one it can encode among those the viewer can play.
 */
export const ENCODED_AUDIO_TYPES = [
  'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus',
  // Chromium has no AAC encoder on Linux: MP4 with Opus is the only MP4 a Linux host records with sound.
  'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
] as const;
export const ENCODED_VIDEO_TYPES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4;codecs=avc1.42E01E'] as const;

/**
 * With sound requested, the video-only formats stay offered after the audio
 * ones: a silent picture beats an error when host and viewer share no audio codec.
 */
export function encodedMimeTypes(audio: boolean, isTypeSupported: (type: string) => boolean): string[] {
  const candidates: readonly string[] = audio ? [...ENCODED_AUDIO_TYPES, ...ENCODED_VIDEO_TYPES] : ENCODED_VIDEO_TYPES;
  return candidates.filter((type) => isTypeSupported(type));
}
