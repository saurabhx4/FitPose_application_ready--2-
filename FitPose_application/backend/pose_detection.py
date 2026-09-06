"""MediaPipe Tasks pose detection, exercise analysis, and landmark drawing."""

from __future__ import annotations

import math
import os
import threading
import time
from pathlib import Path

import cv2
import mediapipe as mp

from one_euro_filter import PoseSmoother
from ml_egcn import egcn_predictor


def _resolve_model_path() -> Path:
    """Pick the most precise BlazePose checkpoint actually available on disk.

    MediaPipe ships three tiers, trading latency for landmark accuracy:
    lite (bundled by default) < full < heavy. An explicit
    POSE_LANDMARKER_MODEL env var always wins; otherwise this prefers
    POSE_MODEL_TIER (default "lite") and falls back down the tiers if the
    requested file isn't present, so a missing download never crashes the
    server. To get a more precise skeleton: download pose_landmarker_full.task
    or pose_landmarker_heavy.task from Google's MediaPipe model zoo
    (https://storage.googleapis.com/mediapipe-models/pose_landmarker/) into
    backend/models/, then set POSE_MODEL_TIER=full (or "heavy").
    """
    explicit = os.environ.get("POSE_LANDMARKER_MODEL")
    if explicit:
        return Path(explicit)

    models_dir = Path(__file__).with_name("models")
    tier_files = {
        "lite": "pose_landmarker_lite.task",
        "full": "pose_landmarker_full.task",
        "heavy": "pose_landmarker_heavy.task",
    }
    requested = os.environ.get("POSE_MODEL_TIER", "lite").strip().lower()
    order = {
        "heavy": ["heavy", "full", "lite"],
        "full": ["full", "lite"],
    }.get(requested, ["lite"])
    for tier in order:
        candidate = models_dir / tier_files[tier]
        if candidate.is_file():
            return candidate
    # Nothing found at any tier — return the lite path anyway so the
    # existing FileNotFoundError below reports a clear, actionable message.
    return models_dir / tier_files["lite"]


MODEL_PATH = _resolve_model_path()

# Landmark index pairs from the 33-point BlazePose landmark layout.
POSE_CONNECTIONS = (
    (0, 1), (1, 2), (2, 3), (3, 7), (0, 4), (4, 5), (5, 6), (6, 8),
    (9, 10), (11, 12), (11, 13), (13, 15), (15, 17), (15, 19), (15, 21),
    (17, 19), (12, 14), (14, 16), (16, 18), (16, 20), (16, 22), (18, 20),
    (11, 23), (12, 24), (23, 24), (23, 25), (24, 26), (25, 27), (26, 28),
    (27, 29), (28, 30), (29, 31), (30, 32), (27, 31), (28, 32),
)

# MediaPipe pose landmark indices used for joint-angle analysis.
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_HIP, RIGHT_HIP = 23, 24
LEFT_KNEE, RIGHT_KNEE = 25, 26
LEFT_ANKLE, RIGHT_ANKLE = 27, 28
NOSE = 0


def _create_landmarker() -> mp.tasks.vision.PoseLandmarker:
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"Pose model was not found at '{MODEL_PATH}'. "
            "Download pose_landmarker_lite.task into backend/models or set "
            "the POSE_LANDMARKER_MODEL environment variable."
        )

    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_poses=1,
        # Back at MediaPipe's 0.5 defaults. The previous 0.6/0.6/0.65 values
        # were tuned against jitter but ended up rejecting whole-body frames
        # (esp. legs/feet, or anyone not perfectly centered) too often,
        # which is what produced a partial/upper-body-only skeleton instead
        # of full-body coverage. The 0.3 per-landmark draw threshold above
        # (plus the One-Euro smoother) now carries the anti-jitter job.
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return mp.tasks.vision.PoseLandmarker.create_from_options(options)


class ExerciseAnalyzer:
    """Analyzes pose landmarks and produces exercise-specific feedback from joint angles."""

    def __init__(self) -> None:
        self.rep_count = 0
        self.phase = "up"
        self._exercise_confidence = 0
        self._active_exercise: str | None = None
        self._session_state = "idle"

    @staticmethod
    def _angle(first, vertex, third) -> float:
        """Return a 2D joint angle in degrees for three normalized landmarks."""
        first_vector = (first.x - vertex.x, first.y - vertex.y)
        third_vector = (third.x - vertex.x, third.y - vertex.y)
        first_length = math.hypot(*first_vector)
        third_length = math.hypot(*third_vector)
        if not first_length or not third_length:
            return 0.0
        cosine = (
            first_vector[0] * third_vector[0] + first_vector[1] * third_vector[1]
        ) / (first_length * third_length)
        return round(math.degrees(math.acos(max(-1.0, min(1.0, cosine)))), 1)

    @staticmethod
    def _midpoint(first, second):
        return type("Midpoint", (), {"x": (first.x + second.x) / 2, "y": (first.y + second.y) / 2, "z": (first.z + second.z) / 2, "visibility": (first.visibility + second.visibility) / 2})()

    def _joint_angles(self, landmarks) -> dict[str, float]:
        shoulder_mid = self._midpoint(landmarks[LEFT_SHOULDER], landmarks[RIGHT_SHOULDER])
        hip_mid = self._midpoint(landmarks[LEFT_HIP], landmarks[RIGHT_HIP])
        knee_mid = self._midpoint(landmarks[LEFT_KNEE], landmarks[RIGHT_KNEE])
        return {
            "left_elbow": self._angle(landmarks[LEFT_SHOULDER], landmarks[LEFT_ELBOW], landmarks[LEFT_WRIST]),
            "right_elbow": self._angle(landmarks[RIGHT_SHOULDER], landmarks[RIGHT_ELBOW], landmarks[RIGHT_WRIST]),
            "left_shoulder": self._angle(landmarks[LEFT_ELBOW], landmarks[LEFT_SHOULDER], landmarks[LEFT_HIP]),
            "right_shoulder": self._angle(landmarks[RIGHT_ELBOW], landmarks[RIGHT_SHOULDER], landmarks[RIGHT_HIP]),
            "left_hip": self._angle(landmarks[LEFT_SHOULDER], landmarks[LEFT_HIP], landmarks[LEFT_KNEE]),
            "right_hip": self._angle(landmarks[RIGHT_SHOULDER], landmarks[RIGHT_HIP], landmarks[RIGHT_KNEE]),
            "left_knee": self._angle(landmarks[LEFT_HIP], landmarks[LEFT_KNEE], landmarks[LEFT_ANKLE]),
            "right_knee": self._angle(landmarks[RIGHT_HIP], landmarks[RIGHT_KNEE], landmarks[RIGHT_ANKLE]),
            "back": self._angle(shoulder_mid, hip_mid, knee_mid),
            "neck": self._angle(shoulder_mid, landmarks[NOSE], hip_mid),
        }

    @staticmethod
    def _serialize_landmarks(landmarks) -> list[dict[str, float]]:
        return [
            {
                "x": round(landmark.x, 5),
                "y": round(landmark.y, 5),
                "z": round(landmark.z, 5),
                "visibility": round(landmark.visibility, 5),
            }
            for landmark in landmarks
        ]

    @staticmethod
    def _normalize_exercise(exercise: str | None) -> str:
        if not exercise:
            return "squats"
        normalized = str(exercise).strip().lower().replace(" ", "-")
        mapping = {
            "squat": "squats",
            "squats": "squats",
            "push-up": "push-up",
            "pushup": "push-up",
            "plank": "plank",
            "shoulder-raise": "shoulder-raise",
            "shoulder-raises": "shoulder-raise",
            "knee-bend": "knee-bend",
            "neck-stretch": "neck-stretch",
            "hip-rotation": "hip-rotation",
        }
        return mapping.get(normalized, "squats")

    def _confidence_score(self, landmarks, angles: dict[str, float]) -> float:
        relevant_visibility = [
            landmark.visibility
            for landmark in landmarks
            if getattr(landmark, "visibility", 0.0) is not None
        ]
        visibility_score = sum(relevant_visibility) / len(relevant_visibility) if relevant_visibility else 0.0
        asymmetry_penalty = (
            abs(angles["left_knee"] - angles["right_knee"]) / 90
            + abs(angles["left_elbow"] - angles["right_elbow"]) / 90
            + abs(angles["left_shoulder"] - angles["right_shoulder"]) / 90
        ) / 3
        return round(max(0.0, min(1.0, 0.6 * visibility_score + 0.4 * (1 - min(1.0, asymmetry_penalty)))), 2)

    def _detect_exercise(self, angles: dict[str, float], exercise: str | None = None) -> str | None:
        exercise_key = self._normalize_exercise(exercise)
        average_knee_angle = (angles["left_knee"] + angles["right_knee"]) / 2
        average_elbow_angle = (angles["left_elbow"] + angles["right_elbow"]) / 2
        average_shoulder_angle = (angles["left_shoulder"] + angles["right_shoulder"]) / 2

        if exercise_key == "squats":
            if average_knee_angle <= 130 and average_knee_angle >= 70:
                return "squats"
            return None

        if exercise_key == "push-up":
            if average_elbow_angle <= 130 and average_elbow_angle >= 70:
                return "push-up"
            return None

        if exercise_key == "plank":
            if angles["back"] <= 180 and angles["back"] >= 140 and average_shoulder_angle <= 180 and average_shoulder_angle >= 120:
                return "plank"
            return None

        if exercise_key == "shoulder-raise":
            if average_elbow_angle >= 120:
                return "shoulder-raise"
            return None

        return None

    def _update_active_exercise(self, detected_exercise: str | None) -> str | None:
        if detected_exercise is None:
            self._exercise_confidence = 0
            self._active_exercise = None
            self._session_state = "idle"
            return None

        if self._active_exercise == detected_exercise:
            self._exercise_confidence = min(3, self._exercise_confidence + 1)
        else:
            self._active_exercise = detected_exercise
            self._exercise_confidence = 1

        if self._exercise_confidence == 1:
            self._session_state = "starting"
        elif self._exercise_confidence == 2:
            self._session_state = "active"
        else:
            self._session_state = "active"

        return detected_exercise if self._exercise_confidence >= 3 else None

    def analyze(self, landmarks: list | None, exercise: str | None = None) -> dict:
        if not landmarks:
            return {
                "rep_count": self.rep_count,
                "posture_status": "No exercise detected",
                "accuracy": 0,
                "feedback": "No exercise detected.",
                "detected_issues": ["No exercise detected"],
                "joint_angles": {},
                "confidence_score": 0.0,
                "personalized_correction": "Stand still and begin the movement so exercise detection can start.",
                "session_state": "idle",
                "landmarks": [],
            }

        angles = self._joint_angles(landmarks)
        average_knee_angle = (angles["left_knee"] + angles["right_knee"]) / 2
        average_elbow_angle = (angles["left_elbow"] + angles["right_elbow"]) / 2
        knee_difference = abs(angles["left_knee"] - angles["right_knee"])
        shoulder_difference = abs(angles["left_shoulder"] - angles["right_shoulder"])
        detected_exercise = self._update_active_exercise(self._detect_exercise(angles, exercise=exercise))

        if detected_exercise == "squats":
            if average_knee_angle <= 110:
                self.phase = "down"
            elif self.phase == "down" and average_knee_angle >= 160:
                self.rep_count += 1
                self.phase = "up"

        issues: list[str] = []
        corrections: list[str] = []
        # Machine-readable issue codes, same priority order as issues/corrections.
        # Kept separate from the human-readable (degree-bearing) text above so a
        # voice assistant can speak SPOKEN_CORRECTIONS instead of reading numbers.
        codes: list[str] = []

        if detected_exercise == "squats":
            if average_knee_angle > 120:
                issues.append(f"Knee depth is too shallow ({average_knee_angle:.1f}°).")
                corrections.append(f"Lower until your knees bend to about 90°; your current knee angle is {average_knee_angle:.1f}°.")
                codes.append("knee_shallow")
            elif average_knee_angle < 70:
                issues.append(f"Knee depth is excessive ({average_knee_angle:.1f}°).")
                corrections.append(f"Reduce the depth slightly and keep your weight in your heels; your knee angle is {average_knee_angle:.1f}°.")
                codes.append("knee_deep")
            if knee_difference > 10:
                issues.append("The knees are not tracking evenly.")
                corrections.append("Keep both knees moving in the same line over your feet.")
                codes.append("knee_uneven")
            if angles["back"] < 145:
                issues.append(f"The torso is leaning forward ({angles['back']:.1f}°).")
                corrections.append(f"Brace your core and keep your torso more upright; trunk angle is {angles['back']:.1f}°.")
                codes.append("torso_lean")
        elif detected_exercise == "push-up":
            if average_elbow_angle > 125:
                issues.append(f"The elbows are not bending enough ({average_elbow_angle:.1f}°).")
                corrections.append(f"Lower until your elbows bend close to 90°; your current elbow angle is {average_elbow_angle:.1f}°.")
                codes.append("elbow_shallow")
            elif average_elbow_angle < 70:
                issues.append(f"The elbows are bending too sharply ({average_elbow_angle:.1f}°).")
                corrections.append(f"Stop the descent sooner and keep the shoulders stacked over the wrists; current elbow angle is {average_elbow_angle:.1f}°.")
                codes.append("elbow_deep")
            if shoulder_difference > 10:
                issues.append("The shoulders are not level.")
                corrections.append("Keep your shoulders level and your hips square to the floor.")
                codes.append("shoulder_uneven")
        elif detected_exercise == "plank":
            if angles["back"] < 145:
                issues.append(f"The hips are sagging ({angles['back']:.1f}°).")
                corrections.append(f"Brace your core and raise your hips until your body forms a straight line; trunk angle is {angles['back']:.1f}°.")
                codes.append("hip_sag")
            if angles["neck"] < 140:
                issues.append(f"The head is dropping forward ({angles['neck']:.1f}°).")
                corrections.append(f"Keep your neck neutral and look slightly forward; neck angle is {angles['neck']:.1f}°.")
                codes.append("head_drop")
        elif detected_exercise == "shoulder-raise":
            if average_elbow_angle > 145:
                issues.append(f"The elbows are too bent ({average_elbow_angle:.1f}°).")
                corrections.append(f"Keep a softer elbow bend and raise the arms with the shoulders; current elbow angle is {average_elbow_angle:.1f}°.")
                codes.append("elbow_locked")
            if shoulder_difference > 10:
                issues.append("The shoulders are hiking unevenly.")
                corrections.append("Keep the shoulders relaxed and avoid lifting them toward the ears.")
                codes.append("shoulder_hike")

        if not detected_exercise:
            issues = []
            corrections = []
            codes = []
            accuracy = 0
            posture_status = "No exercise detected"
            feedback = "No exercise detected."
            personalized_correction = "Stand still and begin the movement so exercise detection can start."
            spoken_correction = "I can't see your exercise yet — step into frame and start moving."
        else:
            confidence_score = self._confidence_score(landmarks, angles)
            accuracy = round(max(0, min(100, 100 - len(issues) * 12 - (1 - confidence_score) * 20)))
            posture_status = "Correct posture" if not issues else "Incorrect posture"
            feedback = " ".join(issues) or "Good form. Keep your movement smooth and controlled."
            personalized_correction = corrections[0] if corrections else "Maintain your current alignment and keep the movement controlled."
            # Plain-language, number-free phrase for a voice assistant to read
            # aloud — looked up from SPOKEN_CORRECTIONS by the first issue code,
            # falling back to the (already number-free) encouragement line.
            exercise_table = SPOKEN_CORRECTIONS.get(detected_exercise, {})
            spoken_correction = (
                exercise_table.get(codes[0]) if codes else None
            ) or "Nice, keep the movement smooth and controlled."

        return {
            "rep_count": self.rep_count,
            "posture_status": posture_status,
            "accuracy": accuracy,
            "feedback": feedback,
            "detected_issues": issues if detected_exercise else ["No exercise detected"],
            "issue_codes": codes if detected_exercise else [],
            "joint_angles": angles,
            "confidence_score": confidence_score if detected_exercise else 0.0,
            "personalized_correction": personalized_correction,
            "spoken_correction": spoken_correction,
            "session_state": self._session_state,
            "landmarks": self._serialize_landmarks(landmarks),
        }


landmarker = None

# ---- Plain-language corrections, keyed by the machine-readable issue codes
# ExerciseAnalyzer emits below. This mirrors src/js/voiceCoach.js's CORRECTIONS
# table so the backend and the in-browser analyzer speak the same way: no
# joint-angle numbers, just short, natural instructions a voice assistant can
# read aloud ("bend your knees a bit more" instead of "knee angle is 71.4°").
SPOKEN_CORRECTIONS = {
    "squats": {
        "knee_shallow": "Lower your hips a bit more. Bend your knees closer to ninety degrees.",
        "knee_deep": "You're going a little too low. Rise up slightly and stay in control.",
        "knee_uneven": "Keep both knees tracking evenly over your feet.",
        "torso_lean": "Keep your chest up and your back straighter.",
    },
    "push-up": {
        "elbow_shallow": "Lower your chest closer to the floor. Bend your elbows a bit more.",
        "elbow_deep": "Don't drop too low. Control the bottom of the movement.",
        "shoulder_uneven": "Keep your shoulders level.",
    },
    "plank": {
        "hip_sag": "Lift your hips. Keep a straight line from your head to your heels.",
        "head_drop": "Look slightly forward and keep your neck neutral.",
    },
    "shoulder-raise": {
        "elbow_locked": "Keep a soft bend in your elbows.",
        "shoulder_hike": "Relax your shoulders, don't shrug them up.",
    },
}

analyzer = ExerciseAnalyzer()
smoother = PoseSmoother()
_last_timestamp_ms = 0
_detection_lock = threading.Lock()


def _get_landmarker():
    global landmarker
    if landmarker is None:
        landmarker = _create_landmarker()
    return landmarker


def _depth_scale(landmark) -> float:
    """Map BlazePose's hip-relative z into a soft size multiplier so limbs
    closer to the camera read as slightly larger/brighter — a cheap depth
    cue that makes the skeleton look three-dimensional instead of a flat
    wireframe traced on top of the video."""
    z = getattr(landmark, "z", 0.0) or 0.0
    return max(0.75, min(1.35, 1 - z * 1.4))


def _draw_pose(frame, pose_landmarks) -> None:
    """Draw MediaPipe Tasks landmarks and skeleton connections using OpenCV.

    Renders the full 33-point BlazePose connection set (not just the major
    limbs) with visibility-weighted, depth-scaled line/joint thickness and
    anti-aliasing throughout, so the overlay reads as a precise, well-defined
    skeleton rather than a thin flat outline.
    """
    height, width = frame.shape[:2]
    points = [(int(item.x * width), int(item.y * height)) for item in pose_landmarks]
    base_radius = max(3, width // 160)
    base_thickness = max(2, width // 300)

    for start, end in POSE_CONNECTIONS:
        if start >= len(points) or end >= len(points):
            continue
        vis_a = pose_landmarks[start].visibility
        vis_b = pose_landmarks[end].visibility
        # Lowered from 0.45 to match the frontend canvas: legs/feet routinely
        # sit at 0.3-0.45 confidence on the lite model even when clearly in
        # frame, which was dropping those connections and rendering an
        # upper-body-only skeleton instead of the full body.
        if vis_a < 0.3 or vis_b < 0.3:
            continue
        confidence = min(vis_a, vis_b)
        scale = (_depth_scale(pose_landmarks[start]) + _depth_scale(pose_landmarks[end])) / 2
        thickness = max(1, round(base_thickness * scale))
        # Green core line, brightness scaled by joint-pair confidence, gives
        # a visibly crisper skeleton than the old flat fixed-color stroke.
        color = (0, int(150 + 105 * confidence), int(60 * confidence))
        cv2.line(frame, points[start], points[end], color, thickness, cv2.LINE_AA)

    for index, (x, y) in enumerate(points):
        visibility = pose_landmarks[index].visibility
        if visibility < 0.3:
            continue
        radius = max(2, round(base_radius * _depth_scale(pose_landmarks[index])))
        # Filled joint with a dark outline reads more precisely against both
        # light and dark backgrounds than a flat filled dot.
        cv2.circle(frame, (x, y), radius, (30, 30, 200), -1, cv2.LINE_AA)
        cv2.circle(frame, (x, y), radius, (15, 15, 90), 1, cv2.LINE_AA)


def _run_detection(frame):
    global _last_timestamp_ms
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    timestamp_ms = max(int(time.monotonic() * 1000), _last_timestamp_ms + 1)
    _last_timestamp_ms = timestamp_ms
    return _get_landmarker().detect_for_video(image, timestamp_ms)


def detect_and_analyze(frame, exercise: str | None = None, session_id: str = "default"):
    """Detect a pose, draw it on ``frame``, and return the analysis JSON data."""
    with _detection_lock:
        results = _run_detection(frame)
        landmarks = results.pose_landmarks[0] if results.pose_landmarks else None
        if landmarks:
            # Smooth before analysis and drawing: this removes frame-to-frame
            # jitter from both the joint-angle math (steadier feedback/rep
            # counting) and the rendered skeleton, at the cost of a small,
            # velocity-adaptive amount of lag (see one_euro_filter.py).
            landmarks = smoother.smooth(landmarks, time.monotonic())
        else:
            smoother.reset()
        analysis = analyzer.analyze(landmarks, exercise=exercise)

        # ---- EGCN exercise/condition classification (ml/ project) --------
        # Feeds the same smoothed landmarks into a rolling 64-frame buffer;
        # once full, the trained EGCN (backend/ml_egcn) classifies which of
        # its 10 known exercises is being performed and whether the
        # movement looks correct or incorrect. This runs alongside, not
        # instead of, the rule-based ExerciseAnalyzer above — it never
        # blocks or fails a response if the model/weights aren't available.
        if landmarks:
            egcn_predictor.add_frame(landmarks, session_id=session_id)
        else:
            egcn_predictor.reset(session_id=session_id)
        try:
            analysis["ml_prediction"] = egcn_predictor.predict(session_id=session_id)
        except Exception as exc:  # model/weights missing, bad frame, etc.
            analysis["ml_prediction"] = {"ready": False, "error": str(exc)}

    if landmarks:
        _draw_pose(frame, landmarks)
    return frame, results, analysis


def detect_pose(frame, exercise: str | None = None):
    """Backward-compatible landmark detection used by the webcam view."""
    frame, results, _ = detect_and_analyze(frame, exercise=exercise)
    return frame, results


def close_pose_detector() -> None:
    """Release the native MediaPipe Tasks resources."""
    if landmarker is not None:
        landmarker.close()
        landmarker = None





