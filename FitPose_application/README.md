# FitPose

### AI Movement & Posture Coaching App

## Team Members
- Saamiya
- Saurabh
- Nandini
- Shreya

## What this is
A fully working single-page web app: real camera-based AI pose detection, rep
counting and live form feedback, auth, a dashboard/progress tracker, an
exercise library, a rule-based AI coach chat, and a profile page — all wired
to a real (local) data layer, no backend server required.

## Run it
```bash
npm install
cp .env.example .env   # then put a real Google OAuth Client ID inside — see below
npm run dev
```
Then open the URL Vite prints (defaults to `http://localhost:5173`).

### Setting up "Continue with Google" (required for real Google sign-in)
The Google button uses real Google OAuth (Google Identity Services), not a
mock/demo account, so it needs a real Client ID:
1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth client ID** of type **Web application**.
3. Under **Authorized JavaScript origins**, add `http://localhost:5173` (and
   your real domain once you deploy).
4. Copy the Client ID into `.env` as `VITE_GOOGLE_CLIENT_ID=...`, then restart `npm run dev`.

Without this, the "Continue with Google" button will show a clear error
instead of silently faking a login.

### Optional: Google Cloud persistence + automatic sign-in
By default, account/workout data lives only in the current browser's local
storage. To have Google-linked accounts persist to Google Cloud (and have
the site automatically sign a returning person back in with their saved
progress, using a stored session token instead of a fresh Google prompt):
1. Set up `backend/.env` from `backend/.env.example` — a GCP service-account
   key with Firestore access, your Firestore project id, and a random
   `SESSION_SECRET`.
2. Install the backend deps and run it: `pip install -r backend/requirements.txt`
   then `npm run api` (or `python backend/app.py`).
3. Set `VITE_API_BASE_URL` in your `.env` to wherever that backend is
   reachable (e.g. `http://localhost:5000`), then restart `npm run dev`.

Leave `VITE_API_BASE_URL` blank to keep everything local-only, exactly as
before — nothing else changes.

### Optional: real AI Coach (OpenAI-backed chat)
By default, the "AI Coach" chat (`AI` page) runs entirely on-device: a small
rule-based classifier (`src/js/physioML.js` + `src/js/coach.js`), no network
call, no API key. To upgrade it to a real LLM that acts strictly as an
in-app physiotherapist assistant — it asks how long a reported problem
(e.g. "I have neck pain") has lasted, then schedules real exercises from the
catalog for a set number of days, tracked as its own "Recovery Plan" with a
dedicated daily streak (`src/js/store.js`'s `recoveryPlan`):
1. Add `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default
   `gpt-4o-mini`) to `backend/.env` — see `backend/.env.example`.
2. Install the backend deps (this now includes the `openai` package) and
   run it: `pip install -r backend/requirements.txt` then `npm run api` (or
   `python backend/app.py`).
3. Set `VITE_API_BASE_URL` in your `.env` to that backend's URL, then
   restart `npm run dev`.

Leave `OPENAI_API_KEY` unset (or `VITE_API_BASE_URL` blank) to keep the chat
on the built-in on-device coach — the frontend detects this automatically
and falls back with no errors either way.

No build step is required to just try it — you can also open `index.html`
directly from a static file server (camera access requires `https://` or
`localhost`, so a plain `file://` open won't allow the webcam).

Production build:
```bash
npm run build
npm run preview
```

## How it works
- **Pose detection** (`src/js/pose.js`) runs entirely in the browser using
  Google's MediaPipe Tasks Vision `PoseLandmarker`, loaded from a CDN at
  runtime. Nothing from your camera is ever uploaded — all analysis happens
  on-device. The joint-angle/rep-counting/form-scoring logic mirrors
  `backend/pose_detection.py` line-for-line so both stay consistent if you
  later want to move analysis server-side.
- **Auth & data** (`src/js/store.js`). Identity comes from real Google OAuth
  (Google Identity Services token flow, verified against Google's own
  userinfo endpoint) or from SHA-256-hashed email/password credentials the
  person sets themselves — including a separate app password a Google user
  can add later from their Profile page so they can sign in without Google
  next time. There is no backend/database in this project, so account
  records, the password hash, and each person's workout history are still
  persisted in this browser's `localStorage`, per account. Swap
  `dataKey()`/`readJSON()`/`writeJSON()` for real API calls whenever you wire
  up a backend — the rest of the app only ever talks to this module. New
  accounts start with zero sessions, an empty calendar, and no streak; it all
  fills in from real recorded workouts.
- **Exercise Preview** (`src/js/exercisePreview.js`) — a "▶ Exercise Preview"
  button below the Workout page's camera frame, and a "▶ Preview" button on
  every card in the Exercise Library, opens a large modal centered over the
  page with a looping, pure-CSS animated stick figure demonstrating that
  exercise's motion, plus a numbered how-to list (`steps` in `exercises.js`).
  No video/image assets are used — the figure is built from styled `<div>`s
  animated with per-exercise CSS keyframes (see the `.pf-*`/`.ex-*` rules at
  the end of `style.css`), so it loads instantly and works offline. "Start
  this exercise →" inside the modal jumps straight into that workout.
- **Live voice coaching** (`src/js/voice.js` + `src/js/voiceCoach.js`) speaks
  form feedback out loud during a live session using the browser's built-in
  Web Speech API — nothing recorded or sent anywhere. It announces when a
  session starts, calls out specific corrections per exercise (e.g. for
  squats: "lower your hips," "look straight ahead," "bend your knees closer
  to ninety degrees"), gives occasional encouragement when your form is good,
  calls out rep milestones, and reads a short summary when you finish. A
  🔊/🔇 button on the Workout page mutes it any time; the preference is
  remembered. The exact issue → phrase mapping per exercise lives in
  `voiceCoach.js`; the underlying angle checks that decide which issue fires
  live in `pose.js` (`issue_codes`).
- **AI Coach** (`src/js/coach.js`) is a lightweight, rule-based responder that
  reads your real session data (streak, average form, last workout) to reply
  — no external LLM key is configured, so it works fully offline.
- **UI** (`index.html` + `src/js/app.js` + `src/css/style.css`) is the
  provided FitPose design, made fully interactive: every button, tab, form
  and camera control on every page is wired to real state.

## Skeleton precision & smoothing
Pose landmarks are stabilized with a One Euro filter (`src/js/oneEuroFilter.js`,
mirrored server-side in `backend/one_euro_filter.py`) before they're used for
drawing, joint angles, or rep counting — this removes the small frame-to-frame
jitter you'd otherwise see in a raw MediaPipe skeleton, while staying
responsive during fast movement. Detection confidence/tracking thresholds
were also raised above MediaPipe's defaults so lower-quality landmark guesses
get filtered out before they reach the screen.

By default the app uses MediaPipe's `lite` BlazePose model (bundled in
`public/models/`). For a more precise skeleton, download the `full` or
`heavy` checkpoint from Google's model zoo and drop it in the same folder
(and `backend/models/` for the Python backend):
- full:  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
- heavy: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task

Then set `VITE_POSE_MODEL_TIER=full` (or `heavy`) in `.env` for the frontend,
and `POSE_MODEL_TIER=full` (or `heavy`) as an environment variable for the
backend. `heavy` gives the most precise landmarks but is the most
compute-heavy of the three — best for a fairly still camera/device with
decent GPU/CPU headroom; `full` is a good middle ground for most laptops.

## Optional: Python backend
`backend/` still contains the original Flask + MediaPipe (Python) pose
analysis service (`npm run api` / `python backend/app.py`) if you'd rather do
server-side analysis for a future mobile client or centralized logging. The
shipped frontend does not require it to run.

### EGCN exercise/condition classifier (`backend/ml_egcn/`)
The backend also folds in a trained Enhanced Graph Convolutional Network
(EGCN) from the companion `ml/` model-training project. Where
`pose_detection.py`'s `ExerciseAnalyzer` is a hand-written, rule-based
joint-angle checker for a handful of exercises, the EGCN is a model trained
on the UI-PRMD skeleton dataset to recognize 10 specific movements (deep
squat, hurdle step, inline lunge, side lunge, sit-to-stand, and five
standing shoulder movements) and call each one "Correct" or "Incorrect"
directly from a 64-frame motion window — the two approaches run side by
side, not as a replacement for one another.

- `backend/ml_egcn/egcn.py` — the model architecture, copied unchanged from
  `ml/models/egcn.py`.
- `backend/ml_egcn/best_egcn.pth` / `adjacency_matrix.npy` — the trained
  weights and 22-joint skeleton graph, copied from `ml/models/` and
  `ml/processed/`.
- `backend/ml_egcn/inference.py` — the integration layer: converts
  MediaPipe's 33 BlazePose landmarks into the 22-joint UI-PRMD layout the
  model expects (same joint construction, root/scale normalization, and
  z-axis dampening as `ml/scripts/mediapipe_to_egcn.py`), buffers 64 frames
  per caller, and runs inference once the buffer fills.

Every `POST /detect_pose` response now includes an `ml_prediction` field
alongside the existing rule-based fields:
```jsonc
{
  "...": "existing ExerciseAnalyzer fields (rep_count, feedback, joint_angles, ...)",
  "ml_prediction": {
    "ready": true,
    "exercise": "Deep Squat",
    "exercise_confidence": 0.94,
    "condition": "Correct",
    "condition_confidence": 0.88,
    "top3": [{ "exercise": "Deep Squat", "confidence": 0.94 }, "..."]
  }
}
```
Before 64 frames have been collected for a caller, `ml_prediction` is
`{"ready": false, "frames_collected": N, "frames_needed": 64}` instead.
Send a stable `session_id` (form field, query param, JSON body field, or
`X-Session-Id` header) with each request so concurrent callers — e.g. more
than one browser tab — don't share and corrupt each other's 64-frame
window; callers that omit it share one `"default"` buffer.

Requires `torch` (added to `backend/requirements.txt`); it's the only new
dependency this integration needs. Nothing in `ml/` is retrained or
modified — `backend/ml_egcn/` is a read-only copy of the trained artifacts.

## Tech stack
- Vanilla HTML / CSS / JavaScript (ES modules) — no framework, no build step
  required to run
- MediaPipe Tasks Vision (in-browser AI pose detection)
- Vite (dev server + optional production bundling)
