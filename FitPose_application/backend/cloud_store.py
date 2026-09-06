"""Google Cloud–backed persistence for FitPose accounts + workout progress.

Wires the "Continue with Google" flow on the frontend (see
src/js/store.js) to real, durable storage: once someone signs in with
Google, their profile and workout data live in Google Cloud Firestore,
keyed by their Google account. A short-lived signed session token then
lets the site automatically sign them back in on a later visit (see
GET /api/session) without them having to go through Google again, and
without ever trusting anything the browser claims about who it is —
every identity check here is re-verified against Google or against our
own signed token.

Required setup (see backend/.env.example):
  GOOGLE_APPLICATION_CREDENTIALS  path to a GCP service-account JSON key
                                   with Firestore access (or run on GCP
                                   infra that already has a default
                                   service account attached).
  FIRESTORE_PROJECT_ID            GCP project id (optional if it can be
                                   inferred from the credentials).
  SESSION_SECRET                  a long random string used to sign the
                                   session tokens issued below.

Nothing here is reachable unless backend/app.py's /api/* routes are
called, and every call fails loudly — never silently — if Firestore or
the session secret aren't configured, matching the frontend's existing
"no fake data" policy for Google sign-in.
"""

import json
import os
import tempfile
import time

import jwt
import requests
from google.cloud import firestore

# Most hosting platforms (Render, Railway, Fly.io, etc.) let you set
# environment variables but not drop a file at a fixed path. So: if
# GOOGLE_APPLICATION_CREDENTIALS_JSON holds the *contents* of the service
# account key (paste the whole JSON file as one env var), write it to a
# temp file and point GOOGLE_APPLICATION_CREDENTIALS at that — this runs
# once, before firestore.Client() is ever created below. If you're on a
# GCP-native host instead (e.g. Cloud Run) with a service account already
# attached to the service, you don't need either of these — Firestore
# picks up the attached identity automatically.
if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON") and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    _cred_file = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
    _cred_file.write(os.environ["GOOGLE_APPLICATION_CREDENTIALS_JSON"])
    _cred_file.close()
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = _cred_file.name

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
SESSION_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days of "keep me signed in"

DEFAULT_DATA = {
    "goals": [],
    "sessions": [],
    "calendarDays": {},
    "stats": {"streak": 0, "bestStreak": 0},
}

_db = None


def _client():
    global _db
    if _db is None:
        _db = firestore.Client(project=os.environ.get("FIRESTORE_PROJECT_ID") or None)
    return _db


def _users():
    return _client().collection("fitpose_users")


def verify_google_access_token(access_token):
    """Re-confirms the token with Google itself; never trusts the client's word."""
    resp = requests.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    if resp.status_code != 200:
        raise ValueError("Could not verify this Google account.")
    profile = resp.json()
    if not profile.get("email") or not profile.get("sub"):
        raise ValueError("Google did not return a verified account.")
    return profile


def issue_session_token(sub, email):
    if not SESSION_SECRET:
        raise RuntimeError("SESSION_SECRET is not configured on the server.")
    now = int(time.time())
    payload = {"sub": sub, "email": email, "iat": now, "exp": now + SESSION_TTL_SECONDS}
    return jwt.encode(payload, SESSION_SECRET, algorithm="HS256")


def verify_session_token(token):
    if not SESSION_SECRET:
        raise RuntimeError("SESSION_SECRET is not configured on the server.")
    return jwt.decode(token, SESSION_SECRET, algorithms=["HS256"])


def get_or_create_user(profile):
    """Upserts the Google-verified profile and returns the stored record."""
    doc_ref = _users().document(profile["sub"])
    snap = doc_ref.get()
    if snap.exists:
        record = snap.to_dict()
        if profile.get("name") and not record.get("name"):
            record["name"] = profile["name"]
        if profile.get("picture"):
            record["picture"] = profile["picture"]
        doc_ref.set(record, merge=True)
        return record
    record = {
        "sub": profile["sub"],
        "email": profile["email"].strip().lower(),
        "name": profile.get("name") or profile["email"].split("@")[0],
        "picture": profile.get("picture"),
        "data": dict(DEFAULT_DATA),
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    doc_ref.set(record)
    return record


def get_user_by_sub(sub):
    snap = _users().document(sub).get()
    return snap.to_dict() if snap.exists else None


def save_user_data(sub, data):
    _users().document(sub).set({"data": data, "updatedAt": firestore.SERVER_TIMESTAMP}, merge=True)
