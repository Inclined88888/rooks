# Third-party speech models

The Timon desktop client never ships a speech model inside its installer. When
the user asks for one in Settings › Voice, the client downloads it from Hugging
Face, at a pinned revision, and checks every file against its pinned sha256
(`src/speech-catalog/builtin.ts`). Each model stays under its own licence; the
Voice pane shows its attribution and links to it.

## Parakeet TDT 0.6B v3 (int8)

- Upstream: NVIDIA, Parakeet TDT 0.6B v3 — <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- Files: sherpa-onnx export `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`
- Licence: Creative Commons Attribution 4.0 International (CC-BY-4.0) — <https://creativecommons.org/licenses/by/4.0/>

## Canary 180M Flash (int8)

- Upstream: NVIDIA, Canary 180M Flash — <https://huggingface.co/nvidia/canary-180m-flash>
- Files: sherpa-onnx export `csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8`
- Licence: Creative Commons Attribution 4.0 International (CC-BY-4.0) — <https://creativecommons.org/licenses/by/4.0/>

## Cohere Transcribe 03-2026 (int8, 14 languages)

- Upstream: Cohere Labs, Cohere Transcribe 03-2026 — <https://huggingface.co/CohereLabs/cohere-transcribe-03-2026>
- Files: sherpa-onnx int8 export `csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01`, converted from the upstream model
- Licence: Apache License, Version 2.0 (Apache-2.0) — <https://www.apache.org/licenses/LICENSE-2.0>

NOTICE

```text
Cohere Transcribe 03-2026
Copyright Cohere Labs.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use these files except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

The ONNX files Timon downloads are an int8 export made for sherpa-onnx by a
third party (csukuangfj2 on Hugging Face) from the upstream model; Timon does
not modify them.
```
