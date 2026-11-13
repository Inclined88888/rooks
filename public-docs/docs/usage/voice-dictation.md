---
title: Voice dictation
sidebar_position: 8.5
---

Dictate instead of typing: the mic in the chat composer writes what you say into your message, and the cockpit's voice mode talks with an agent hands-free.

How it works depends on where you open Rooks:

- **In the desktop app**, dictation runs **on your computer**. Rooks uses a speech model that it downloads once, with your agreement. After that, dictation works offline and your voice never leaves your machine.
- **In a browser**, Rooks uses the browser's own speech recognition when it has one (Chrome, Edge, Safari, most mobile browsers). The browser usually sends the audio to its vendor's speech service, and dictation follows the language of Rooks's interface. In a browser without speech recognition, such as Firefox, the mic says dictation is not available.

The rest of this page is about the desktop app.

## First use: downloading a speech model

The first time you click the mic (in the chat, or in the cockpit's voice mode), a **Local dictation** card opens at the top right. It names the speech model Rooks picked for your dictation language and gives its size, and asks before downloading anything: nothing is downloaded and the microphone stays off until you click **Download**.

- For English, French, German or Spanish, the card offers **Canary 180M Flash**, about **207 MB**.
- In **Auto**, or for another language, it offers **Parakeet TDT v3**, about **670 MB**.

Your dictation language starts as the language of Rooks's interface; you can change it in **Settings → Interface → Voice dictation** (see below).

While it downloads, the card shows the progress:

- **Pause** stops the download and keeps what arrived; **Resume** continues from there.
- **Cancel** stops it and deletes the partial files.
- If the connection drops or the download stalls, the card says so and offers **Retry**, which resumes where it stopped.

At the end, Rooks checks the downloaded files, then the card says the model is ready: click the mic to dictate. You can also download models ahead of time from **Settings → Interface → Voice dictation**.

Good to know:

- The download needs a bit more free disk space than the model itself (Rooks keeps about 270 MB free on top of it). If the disk is too full, the card says how much the model needs.
- Models are downloaded from Hugging Face (`huggingface.co`, which redirects to its download servers) over HTTPS, through your system's proxy settings. On a network that blocks it, the download fails with a connection error. Every file is checked against a known fingerprint before it is used: a damaged download is never loaded.
- Models are never part of the installer: an installation without dictation never downloads one.

## Dictating

Click the mic in the chat composer and speak. The text appears in the message box as you talk, and **nothing is sent**: you read it, fix it, and send it yourself.

- The first dictation after Rooks starts takes a moment while the speech engine loads. Speak right away: what you say meanwhile is kept.
- Dictation stops after about 4 seconds of silence, or when you click the mic again.
- **Escape** cancels the dictation and puts the message back as it was before you clicked the mic.
- If you type in the message box, or switch to another conversation, dictation stops: it never writes over what you typed.

In the cockpit's **voice mode**, Rooks sends your sentence to the agent after a pause, then listens again once the answer has been read aloud.

## Choosing the dictation language

**Settings → Interface → Voice dictation → Dictation language** lists **Auto** and the languages of the speech models Rooks offers.

- **A language** (French, for instance): Rooks dictates in that language with the installed model that knows it best. Canary keeps to the language you chose, even on a short sentence.
- **Auto**: the model guesses the language of each sentence, among 25 European languages. On a short sentence it may take French for English and write "Yeah." or "Okay.": in Auto, provisional text only appears once you have spoken for about two seconds, which keeps most of these out of your message. If you always dictate in one language, choose it.

If no installed model knows the language you chose, the next click on the mic offers to download one.

## Provisional text

**Provisional text** sets how early words appear while you speak:

- **Auto** follows the model: live with Canary and Parakeet, final text only with Cohere Transcribe;
- **Live**: as you speak;
- **Delayed**: every few seconds;
- **Final only**: the sentence appears whole, at the pause.

Your choice can only make a model wait longer, never faster: a slow model never shows live text, whatever you choose.

## Speech models

**Settings → Interface → Voice dictation** lists the speech models, grouped as **Installed**, **Available**, **From plugins** and **Your models**. Each card gives the model's size, the memory it needs, its languages and its licence, with buttons to **Download**, pause, resume or **Delete** it. A model of a gigabyte or more asks once more, with its size and memory, before the download starts.

A plugin you installed can offer models for this engine. They appear under **From plugins** with **Add and download**: a box from the desktop app shows the plugin, where the files come from, their size and the licence, and nothing downloads unless you accept. Rooks checks the files before the model can dictate, but cannot vouch for a third-party model. Your voice stays on your computer. A model you added stays when you remove the plugin; delete it from this list.

| Model | Download | Memory while dictating | Languages | Language | Licence |
| --- | --- | --- | --- | --- | --- |
| Canary 180M Flash | 207 MB | up to 0.6 GB | English, French, German, Spanish | the one you choose | CC-BY-4.0, NVIDIA |
| Parakeet TDT v3 | 670 MB | up to 1.6 GB | 25 European languages | guessed (Auto) | CC-BY-4.0, NVIDIA |
| Cohere Transcribe 03-2026 (**Precise**) | 2.9 GB | up to 3.6 GB | 14 languages | must be chosen | Apache-2.0, Cohere Labs |

When you dictate in English, French, German or Spanish with Parakeet only, a card **A more precise model for French (207 MB)** (or your language) offers Canary: once downloaded, it is used for that language automatically.

**Model per language** lets you pick, language by language, which installed model to use. **Automatic** picks the installed model that knows the language best: Canary for its four languages, Parakeet for Auto and the others. Rooks never picks Cohere Transcribe by itself.

**Last dictation** shows which model, language and provisional text the latest dictation used.

These choices are kept on this computer: models are downloaded per computer, not per account.

## The precise model: Cohere Transcribe

**Cohere Transcribe**, marked **Precise**, is the most accurate model Rooks offers, for 14 languages (Arabic, Chinese, Dutch, English, French, German, Greek, Italian, Japanese, Korean, Polish, Portuguese, Spanish, Vietnamese). It comes at a cost, shown before anything is downloaded:

- it weighs **2.9 GB** and needs up to **3.6 GB of memory** while you dictate; the first click on **Download** only shows these figures, the second one starts the download;
- it needs a **dictation language**: it cannot guess it, so it is never used in Auto;
- it shows the **final text only**, once you pause, never provisional text while you speak.

Rooks never picks it by itself: once it is downloaded, choose it for a language under **Model per language**. The model comes from Cohere Labs, under the Apache 2.0 licence.

## Adding a local model

**Add a local model…** imports a speech model you already have on disk, in the sherpa-onnx format (NeMo transducer such as Parakeet, NeMo Canary, Whisper or Cohere Transcribe).

1. Rooks opens your system's folder picker: choose the folder that holds the model's files (`encoder`, `decoder`, `tokens`…).
2. If Rooks cannot tell which kind of model it is, it asks; for a model that needs a language (Canary, Cohere Transcribe), it asks for its language codes (`fr`, `en`…). Then choose the folder again.
3. Rooks copies the files into its own folder, checks them, and loads the model once on its own to make sure it works. The model then appears under **Your models**, marked **Not verified**.

Rooks refuses a folder that holds links or shortcuts, sub-folders the model does not use, files a speech model does not use, more than 16 files or more than 8 GB, and a model whose files point outside its folder. The original folder is left untouched; **Delete** removes Rooks's copy.

A speech model is read by native code: **only import models from sources you trust.**

## Where models are stored

Models are stored in Rooks's data folder (`.rooks` in your home folder, under `speech/models`). **Delete** on a model's card removes it from your disk; the next dictation that needs it offers to download it again.

On Windows, when the name of your user folder has accented or non-Latin characters, models are stored in `C:\ProgramData\Rooks\speech-models` instead. Rooks restricts its folder there to your Windows account; if another account on the computer created that folder first, Rooks leaves it alone and uses `C:\Users\Public\Documents\Rooks\speech-models` instead. Uninstalling Rooks with **delete data** removes your models from these folders too, and leaves the folders of other accounts in place.

## Choosing your dictation engine

**Settings → Interface → Voice dictation → Dictation engine** sets which engine dictates, in the chat and in the cockpit's voice mode:

- **Automatic** (the default): Rooks's own engine wherever it can run (the desktop app, and the browser's speech recognition in Chrome, Edge or Safari), and a plugin's engine only where it cannot, such as in Firefox.
- **Browser (Web Speech)**: your browser's speech recognition, offered where the browser has one that works (not in the desktop app). Chrome and Edge send your voice to their vendor's service.
- **Rooks's local engine**, in the desktop app: your voice stays on your computer.
- **An engine from a plugin**, with the plugin's name and where it sends your voice.

The engine's own settings (speech models for Rooks's local engine, a plugin's options) are shown below it. Your choice holds for the machine you are working on.

If the engine you chose cannot run (switched off, not available on this computer), the microphone says so and points to these settings: Rooks never dictates with another engine instead. If you uninstall the plugin of the engine you chose, dictation goes back to **Automatic** and Rooks tells you before dictating.

## Dictation engines from plugins

A plugin can bring its own dictation engine. Such an engine hears what you dictate, so Rooks always says **where your voice goes**: it stays in Rooks's window, it is sent to the Rooks daemon of the machine you work on, or it is sent to the internet addresses the plugin names. This is what the plugin's manifest declares; Rooks shows it in the plugin's card and install sheet in **Plugins**, and in **Settings → Interface → Voice dictation**.

When you choose a plugin's engine, or the first time you dictate with one, a card asks whether this engine may hear you and names that destination. Until you click **Allow**, the microphone stays off and nothing reaches the engine. **Don't allow** keeps the engine off: Rooks does not switch to another engine behind your back.

- Your answer holds for the machine you are working on. Switch to another machine (**Machines**) and Rooks asks again.
- If an update of the plugin changes where your voice goes, Rooks asks again.
- **Settings → Interface → Voice dictation** lists the engines, where each one sends your voice, and lets you choose an engine, allow it or withdraw your consent. Choosing an engine does not allow it: the card still asks.
- An engine whose plugin does not say where your voice goes is never used.

The destination is what the plugin declares and what the reviewer of a signed plugin checks; Rooks cannot technically stop the code of a plugin you installed from doing something else. Install dictation plugins you trust. Rooks's own engine, in the desktop app, needs no such consent: your voice stays on your computer.

## Third-party models and licences

Rooks does not ship or modify these models: each one is downloaded from Hugging Face when you ask for it, and stays under its own licence. Its card in **Settings → Interface → Voice dictation** names its author and links to its licence. In the desktop app, **About Rooks** (tray or menu bar icon menu, the **Rooks** application menu on macOS, or **Settings › System › Installation**) shows the same list with the full NOTICE below.

- **Parakeet TDT 0.6B v3**, by NVIDIA ([model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)), sherpa-onnx int8 export `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`. Licence: [Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).
- **Canary 180M Flash**, by NVIDIA ([model](https://huggingface.co/nvidia/canary-180m-flash)), sherpa-onnx int8 export `csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8`. Licence: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
- **Cohere Transcribe 03-2026**, by Cohere Labs ([model](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)), sherpa-onnx int8 export `csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01`, converted from the upstream model by a third party. Licence: [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).

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
```

A model you add from a local folder keeps whatever licence its author gave it: Rooks does not know it.

## Microphone permission

Only Rooks's own window can use the microphone. Content embedded in the chat (an app in a chat card, for instance) cannot. The built-in browser of a mission is separate: it lets a website use the microphone only after you allow it there.

**macOS.** The first time you dictate, macOS asks whether Rooks may use the microphone. If you refused, Rooks says it is not allowed to use the microphone. To allow it: **System Settings → Privacy & Security → Microphone**, turn Rooks on, then click the mic again. If dictation still fails, quit Rooks and open it again.

**Windows.** Windows does not ask. Dictation needs **Settings → Privacy & security → Microphone → Let desktop apps access your microphone** to be on. If it is off, Rooks says it is not allowed to use the microphone; turn it on and click the mic again.

**Linux.** There is no system permission: Rooks uses your default input device, as set in your sound settings.

## When something goes wrong

| What you see | What to do |
|---|---|
| The mic is greyed out and says dictation is not available in this desktop app | Your computer is not supported (Windows on ARM, 32-bit Linux), or your Rooks is too old: update it. Dictation still works when you open Rooks in Chrome or Edge. |
| "Rooks is not allowed to use the microphone" | Allow the microphone in your system's privacy settings, as described above. |
| "The microphone was disconnected" | The microphone was unplugged during dictation. What you had said stays in the message; plug it back in and click the mic. |
| "Dictation stopped: it was started in another window or panel" | Only one dictation runs at a time. The latest one wins. |
| "The dictation engine stopped unexpectedly" | Click the mic to start again. |
| "The dictation engine could not start" | Try again. If it keeps failing, delete the model in **Settings → Interface → Voice dictation** and download it again. |
| "The downloaded files are damaged" | Click **Retry**: the files are downloaded again. |
| Dictation in French writes English words ("Yeah.", "Okay.") | The dictation language is **Auto**. Choose French in **Settings → Interface → Voice dictation**, and download Canary if Rooks offers it. |
| "This model points to files outside its folder: it was refused" | The local model you added is not safe to load. Use the model's original files. |
| "This folder is not a valid model for this kind of model" | The folder is not a sherpa-onnx model of the kind you chose, or a file is damaged. |

Dictation in the desktop app works on macOS (Apple silicon and Intel), Windows (x64) and Linux (x64 and ARM64).
