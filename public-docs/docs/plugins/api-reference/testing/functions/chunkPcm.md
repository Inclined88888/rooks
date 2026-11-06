
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Function: chunkPcm()

> **chunkPcm**(`pcm`, `chunkMs?`): `Float32Array`\<`ArrayBufferLike`\>[]

Cuts PCM into the blocks the product feeds, about 100 ms each; the last one may be shorter. Copies, never views.

## Parameters

### pcm

`Float32Array`

### chunkMs?

`number` = `100`

## Returns

`Float32Array`\<`ArrayBufferLike`\>[]
