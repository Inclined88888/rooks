
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: speechLikePcm()

> **speechLikePcm**(`seconds`, `options?`): `Float32Array`

A voiced signal with the energy profile of speech: a 140 Hz fundamental and
two harmonics, opened and closed four times a second like syllables. Enough
for a voice detector or a segmenter; no recogniser will read words in it.
Deterministic: the same arguments give the same samples.

## Parameters

### seconds

`number`

### options?

#### amplitude?

`number`

#### pitchHz?

`number`

#### syllablesPerSecond?

`number`

## Returns

`Float32Array`
