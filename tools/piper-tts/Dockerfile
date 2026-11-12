# Local text-to-speech for the agents.
#
# Why a separate service rather than the browser's Web Speech API: a browser's
# voice catalogue is neither controllable nor predictable — it depends on the
# system, the installed voices, and how the browser exposes them. On the
# maintainer's machine, Chrome never saw the French voices that
# speech-dispatcher did have. Here, ROOKS ships its own voice: the same
# rendering on Chrome, on Brave, and on the phone through Tailscale.
#
# Nothing leaves the machine: piper is an ONNX model running locally, so no
# API billed per character.
FROM python:3.12-slim

RUN pip install --no-cache-dir piper-tts flask

# The model is NOT in the image: 61 MB per voice, and voices must be addable
# without a rebuild. It is mounted from ~/.rooks/tts/voices.
ENV PIPER_VOICE=/voices/fr_FR-tom-medium.onnx

EXPOSE 5000

CMD ["sh", "-c", "python -m piper.http_server --host 0.0.0.0 --port 5000 -m \"$PIPER_VOICE\" --data-dir /voices"]
