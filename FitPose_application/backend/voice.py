"""Voice layer for the existing FitPose AI Coach: speech-to-text (STT) and
text-to-speech (TTS) only.

This module does NOT talk to the AI Coach directly and does NOT contain any
chatbot logic/system prompt of its own. The frontend is responsible for
piping a transcript from `transcribe_audio()` into the existing
`/api/coach` conversation exactly like a typed message, and for sending the
existing AI Coach's reply text into `synthesize_speech()`. That keeps the
existing OpenAI AI Coach in ai_coach.py the single "brain" of the assistant.

Reuses the same OPENAI_API_KEY already configured for the AI Coach — no
separate credential is required.
"""
import os

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None

_client = None
_client_key = None


class VoiceServiceError(Exception):
    """A safe, user-actionable failure from the STT/TTS layer."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _get_client():
    global _client, _client_key
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not OpenAI or not api_key:
        return None
    if _client is None or _client_key != api_key:
        _client = OpenAI(api_key=api_key, timeout=45.0, max_retries=2)
        _client_key = api_key
    return _client


def is_configured():
    return _get_client() is not None


STT_MODEL = os.environ.get("OPENAI_STT_MODEL", "whisper-1").strip() or "whisper-1"
TTS_MODEL = os.environ.get("OPENAI_TTS_MODEL", "tts-1").strip() or "tts-1"
TTS_VOICE = os.environ.get("OPENAI_TTS_VOICE", "alloy").strip() or "alloy"

# Whisper accepts an optional ISO-639-1 language hint to improve accuracy,
# but happily auto-detects when omitted/unrecognized — which is what lets
# this pipeline support English, Hindi, Spanish, French, German, Japanese
# (and anything else someone speaks) without hardcoding a language list here.
# Only forward a hint for codes Whisper actually recognizes as a language.
_WHISPER_LANGUAGE_HINTS = {
    "en", "hi", "es", "fr", "de", "ja", "bn", "ta", "te", "mr", "gu", "kn",
    "ml", "pa", "ur", "zh", "ar", "pt", "ru", "it", "ko", "nl", "tr", "pl",
}

_MIME_TO_EXT = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
}


def _extension_for(filename, mimetype):
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
        if ext:
            return ext
    base = (mimetype or "").split(";")[0].strip().lower()
    return _MIME_TO_EXT.get(base, "webm")


def transcribe_audio(file_bytes, filename=None, mimetype=None, language=None):
    """Send recorded microphone audio to OpenAI's multilingual STT.

    Returns the transcript string (may be empty if no speech was detected —
    callers should treat an empty/whitespace-only result as "no speech").
    """
    client = _get_client()
    if client is None:
        return None
    if not file_bytes:
        raise VoiceServiceError("empty_audio", "No audio was received.")

    ext = _extension_for(filename, mimetype)
    upload_name = f"voice-input.{ext}"

    kwargs = {}
    lang = (language or "").strip().lower()
    if lang in _WHISPER_LANGUAGE_HINTS:
        kwargs["language"] = lang

    try:
        result = client.audio.transcriptions.create(
            model=STT_MODEL,
            file=(upload_name, file_bytes, mimetype or "application/octet-stream"),
            **kwargs,
        )
    except Exception as ex:
        print(f"[voice] STT request failed: {type(ex).__name__}: {ex}")
        if type(ex).__name__ == "AuthenticationError":
            raise VoiceServiceError(
                "invalid_api_key", "FitPose AI could not authenticate with its OpenAI API key."
            ) from ex
        if type(ex).__name__ == "RateLimitError":
            raise VoiceServiceError(
                "rate_limited", "FitPose AI is temporarily rate-limited. Please try again shortly."
            ) from ex
        if type(ex).__name__ in {"APIConnectionError", "APITimeoutError"}:
            raise VoiceServiceError(
                "openai_connection_failed",
                "FitPose AI could not reach OpenAI. Check this server's internet connection and try again.",
            ) from ex
        raise VoiceServiceError(
            "stt_failed", "I couldn't understand the audio. Please try again."
        ) from ex

    text = getattr(result, "text", None)
    if text is None and isinstance(result, dict):
        text = result.get("text")
    return (text or "").strip()


def synthesize_speech(text):
    """Return (audio_bytes, mimetype) for the given text, or None if the
    voice layer isn't configured. Raises VoiceServiceError on a real
    OpenAI-side failure — callers must let the AI reply keep working as text
    even when this raises (TTS failure must never break the chatbot)."""
    client = _get_client()
    if client is None:
        return None
    clean_text = (text or "").strip()
    if not clean_text:
        raise VoiceServiceError("empty_text", "There is no text to speak.")
    # The TTS voice model itself infers pronunciation/language from the input
    # text, so no separate language parameter is needed here — this is what
    # lets multilingual AI Coach replies (English, Hindi, Spanish, French,
    # German, Japanese, ...) each come out sounding correct automatically.
    clean_text = clean_text[:4000]

    try:
        response = client.audio.speech.create(
            model=TTS_MODEL,
            voice=TTS_VOICE,
            input=clean_text,
            response_format="mp3",
        )
    except Exception as ex:
        print(f"[voice] TTS request failed: {type(ex).__name__}: {ex}")
        if type(ex).__name__ == "AuthenticationError":
            raise VoiceServiceError(
                "invalid_api_key", "FitPose AI could not authenticate with its OpenAI API key."
            ) from ex
        if type(ex).__name__ == "RateLimitError":
            raise VoiceServiceError(
                "rate_limited", "FitPose AI is temporarily rate-limited. Please try again shortly."
            ) from ex
        raise VoiceServiceError(
            "tts_failed", "I couldn't generate speech for that reply."
        ) from ex

    audio_bytes = response.read() if hasattr(response, "read") else bytes(response.content)
    return audio_bytes, "audio/mpeg"
