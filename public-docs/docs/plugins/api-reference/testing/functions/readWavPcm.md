
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: readWavPcm()

> **readWavPcm**(`bytes`): `Float32Array`

Samples of a WAV file, for feeding a recording to an engine. Accepts mono
16 kHz only, in 16-bit PCM or 32-bit float (`WAVE_FORMAT_EXTENSIBLE` too):
resampling is not the bench's job (`ffmpeg -i in.wav -ac 1 -ar 16000 out.wav`).
Throws on anything else rather than guessing — a float file read as 16-bit
is noise, and an engine fed noise "fails" for a reason that is not its own.

## Parameters

### bytes

`Uint8Array`

## Returns

`Float32Array`
