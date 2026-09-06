import base64
import os
from pathlib import Path

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request

from pose_detection import detect_and_analyze

# Load backend/.env (GOOGLE_APPLICATION_CREDENTIALS, FIRESTORE_PROJECT_ID,
# SESSION_SECRET, OPENAI_API_KEY, ...) into the process environment before
# cloud_store/ai_coach read them below — handles values with spaces/
# backslashes (e.g. a Windows credentials path) correctly, unlike sourcing
# the file in a shell. Safe if python-dotenv isn't installed or .env is
# missing: everything just falls back to whatever's already in the
# environment, same as before this was added.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().with_name(".env"))
except Exception:
    pass

# Cloud persistence (accounts + workout data for Google sign-in) is optional:
# it needs google-cloud-firestore/PyJWT/requests installed and real GCP
# credentials configured (see backend/cloud_store.py), so importing it is
# wrapped to fail soft — the existing pose-detection endpoints below must
# keep working even on a machine that never sets any of that up.
try:
    import cloud_store
    CLOUD_STORE_AVAILABLE = True
except Exception:
    cloud_store = None
    CLOUD_STORE_AVAILABLE = False

# AI Coach (real OpenAI-backed chat) — same fail-soft import pattern as
# cloud_store above: missing package/key just disables /api/coach (503),
# the frontend then falls back to its on-device rule-based coach.
try:
    import ai_coach
    AI_COACH_AVAILABLE = True
except Exception:
    ai_coach = None
    AI_COACH_AVAILABLE = False

# Voice layer (STT + TTS) for the existing Assistant Voice button — same
# fail-soft import pattern: missing package/key just disables the two
# /api/voice/* endpoints below, and the frontend keeps working as a
# typed-only chat exactly as it did before this feature.
try:
    import voice as voice_service
    VOICE_AVAILABLE = True
except Exception:
    voice_service = None
    VOICE_AVAILABLE = False

app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
    return response


@app.route("/")
def home():
    return "FitPose Backend is Running"


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "FitPose Backend",
        "aiCoach": {
            "available": AI_COACH_AVAILABLE,
            "sdkInstalled": bool(getattr(ai_coach, "OpenAI", None)) if AI_COACH_AVAILABLE else False,
            "configured": bool(os.environ.get("OPENAI_API_KEY")),
            "model": getattr(ai_coach, "MODEL", None) if AI_COACH_AVAILABLE else None,
        },
        "voice": {
            "available": VOICE_AVAILABLE,
            "configured": VOICE_AVAILABLE and voice_service.is_configured(),
            "sttModel": getattr(voice_service, "STT_MODEL", None) if VOICE_AVAILABLE else None,
            "ttsModel": getattr(voice_service, "TTS_MODEL", None) if VOICE_AVAILABLE else None,
        },
    })


@app.route("/detect_pose", methods=["POST", "OPTIONS"])
def detect_pose_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)

    image_file = request.files.get("image") or request.files.get("frame")
    exercise = request.form.get("exercise") or request.args.get("exercise")
    session_id = (
        request.form.get("session_id")
        or request.args.get("session_id")
        or request.headers.get("X-Session-Id")
    )
    if image_file:
        image_bytes = image_file.read()
    else:
        payload = request.get_json(silent=True) or {}
        exercise = exercise or payload.get("exercise")
        session_id = session_id or payload.get("session_id")
        encoded_image = payload.get("image") or payload.get("frame")
        if not encoded_image:
            return jsonify({"error": "Send an image file as 'image' or a base64 image in JSON."}), 400
        if "," in encoded_image:
            encoded_image = encoded_image.split(",", 1)[1]
        try:
            image_bytes = base64.b64decode(encoded_image, validate=True)
        except (ValueError, TypeError):
            return jsonify({"error": "The supplied base64 image is invalid."}), 400

    frame = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        return jsonify({"error": "The supplied file is not a valid image."}), 400

    # A stable session_id (e.g. a per-tab UUID the frontend generates) keeps
    # each caller's 64-frame EGCN buffer (backend/ml_egcn) separate; callers
    # that don't send one share a single "default" buffer.
    _, _, analysis = detect_and_analyze(frame, exercise=exercise, session_id=session_id or "default")
    return jsonify(analysis)


def _bearer_token():
    header = request.headers.get("Authorization", "")
    return header.split(" ", 1)[1] if header.startswith("Bearer ") else None


def _cloud_unavailable_response():
    return jsonify({"error": "Cloud storage is not installed/configured on this server."}), 503


# ---- Google sign-in -> Google Cloud persistence + token auto-login -----
# Mirrors src/js/store.js: the frontend already verifies the Google account
# client-side; these endpoints re-verify it server-side, persist the
# person's profile + workout data to Firestore, and hand back a signed
# session token the frontend can use later to sign them back in
# automatically (GET /api/session) without going through Google again.

@app.route("/api/auth/google", methods=["POST"])
def auth_google():
    if not CLOUD_STORE_AVAILABLE:
        return _cloud_unavailable_response()
    payload = request.get_json(silent=True) or {}
    access_token = payload.get("access_token")
    if not access_token:
        return jsonify({"error": "access_token is required."}), 400
    try:
        profile = cloud_store.verify_google_access_token(access_token)
        record = cloud_store.get_or_create_user(profile)
        session_token = cloud_store.issue_session_token(record["sub"], record["email"])
    except (ValueError, RuntimeError) as ex:
        return jsonify({"error": str(ex)}), 400
    except Exception:
        return _cloud_unavailable_response()
    return jsonify({
        "sessionToken": session_token,
        "user": {"sub": record["sub"], "email": record["email"], "name": record["name"], "picture": record.get("picture")},
        "data": record.get("data"),
    })


@app.route("/api/session", methods=["GET"])
def get_session():
    if not CLOUD_STORE_AVAILABLE:
        return _cloud_unavailable_response()
    token = _bearer_token()
    if not token:
        return jsonify({"error": "Missing session token."}), 401
    try:
        claims = cloud_store.verify_session_token(token)
        record = cloud_store.get_user_by_sub(claims["sub"])
    except Exception:
        return jsonify({"error": "Session expired or invalid."}), 401
    if not record:
        return jsonify({"error": "Account not found."}), 404
    return jsonify({
        "user": {"sub": record["sub"], "email": record["email"], "name": record["name"], "picture": record.get("picture")},
        "data": record.get("data"),
    })


@app.route("/api/data", methods=["PUT"])
def put_data():
    if not CLOUD_STORE_AVAILABLE:
        return _cloud_unavailable_response()
    token = _bearer_token()
    if not token:
        return jsonify({"error": "Missing session token."}), 401
    try:
        claims = cloud_store.verify_session_token(token)
    except Exception:
        return jsonify({"error": "Session expired or invalid."}), 401
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "JSON body required."}), 400
    cloud_store.save_user_data(claims["sub"], data)
    return jsonify({"ok": True})


@app.route("/api/coach", methods=["POST", "OPTIONS"])
def coach_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)
    if not AI_COACH_AVAILABLE:
        return jsonify({"error": "AI Coach is not installed on this server (pip install openai)."}), 503
    payload = request.get_json(silent=True) or {}
    messages = payload.get("messages")
    if not messages:
        return jsonify({"error": "messages is required."}), 400
    exercises = payload.get("exercises") or []
    profile = payload.get("profile") or {}
    try:
        result = ai_coach.get_coach_reply(messages, exercises, profile)
    except ai_coach.CoachServiceError as ex:
        return jsonify({"error": ex.message, "code": ex.code}), 503
    if result is None:
        return jsonify({"error": "OPENAI_API_KEY is not configured on this server."}), 503
    return jsonify(result)


# ---- Voice input/output for the existing Assistant Voice button ----------
# Pipeline: browser microphone -> /api/voice/transcribe (STT) -> the SAME
# existing /api/coach above (frontend does this step, unchanged) ->
# /api/voice/speak (TTS) -> browser speaker. Neither endpoint here talks to
# the AI Coach itself; see backend/voice.py.

MAX_VOICE_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB is generous for a short mic clip


@app.route("/api/voice/transcribe", methods=["POST", "OPTIONS"])
def voice_transcribe_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)
    if not VOICE_AVAILABLE:
        return jsonify({"error": "Voice input is not installed on this server (pip install openai)."}), 503

    audio_file = request.files.get("audio")
    if not audio_file:
        return jsonify({"error": "An 'audio' file is required."}), 400

    audio_bytes = audio_file.read()
    if not audio_bytes:
        return jsonify({"error": "no_speech", "message": "I didn't hear anything. Please try again."}), 422
    if len(audio_bytes) > MAX_VOICE_UPLOAD_BYTES:
        return jsonify({"error": "Recording is too long. Please try a shorter clip."}), 413

    language = request.form.get("language") or request.args.get("language")

    try:
        transcript = voice_service.transcribe_audio(
            audio_bytes,
            filename=audio_file.filename,
            mimetype=audio_file.mimetype,
            language=language,
        )
    except voice_service.VoiceServiceError as ex:
        return jsonify({"error": ex.code, "message": ex.message}), 503

    if transcript is None:
        return jsonify({"error": "OPENAI_API_KEY is not configured on this server."}), 503
    if not transcript.strip():
        return jsonify({"error": "no_speech", "message": "I didn't hear anything. Please try again."}), 422

    return jsonify({"transcript": transcript})


@app.route("/api/voice/speak", methods=["POST", "OPTIONS"])
def voice_speak_endpoint():
    if request.method == "OPTIONS":
        return ("", 204)
    if not VOICE_AVAILABLE:
        return jsonify({"error": "Voice output is not installed on this server (pip install openai)."}), 503

    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if not text or not str(text).strip():
        return jsonify({"error": "text is required."}), 400

    try:
        result = voice_service.synthesize_speech(str(text))
    except voice_service.VoiceServiceError as ex:
        # TTS failure must never break the normal (text) AI Coach reply —
        # the frontend already displays the reply as text before calling
        # this endpoint, so a non-200 here just means no audio plays.
        return jsonify({"error": ex.code, "message": ex.message}), 503

    if result is None:
        return jsonify({"error": "OPENAI_API_KEY is not configured on this server."}), 503

    audio_bytes, mimetype = result
    return Response(audio_bytes, mimetype=mimetype)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
