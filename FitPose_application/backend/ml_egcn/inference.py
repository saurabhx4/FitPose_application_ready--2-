"""Real-time EGCN inference wired into the FitPose pose-detection pipeline.

Ported from ``ml/scripts/mediapipe_to_egcn.py`` (the ml/ project's standalone
webcam diagnostic script) so the same MediaPipe -> UI-PRMD 22-joint
conversion, root/scale normalization, and z-axis dampening now run inside
the Flask backend instead of a separate script. This module does not
retrain the model and never modifies ``best_egcn.pth``.

Differences from the original script (which used the legacy
``mp.solutions.pose`` API and its own webcam loop):
- Landmarks are taken from whatever ``pose_detection.py`` already detected
  for a frame (MediaPipe Tasks Vision ``PoseLandmarker``, the same 33-point
  BlazePose layout, just addressed by plain index instead of the
  ``mp.solutions.pose.PoseLandmark`` enum).
- Frame buffering is exposed as a small class (``EGCNPredictor``) with an
  explicit ``reset()`` instead of a global ``deque`` in a ``while True``
  camera loop, so it can be driven one HTTP request/frame at a time and
  reset whenever the person steps out of frame.
"""

from __future__ import annotations

import threading
from collections import deque
from pathlib import Path
from typing import Sequence

import numpy as np
import torch

from .egcn import EGCN

# ============================================================
# CONFIGURATION (mirrors ml/scripts/mediapipe_to_egcn.py)
# ============================================================

NUM_FRAMES = 64
NUM_JOINTS = 22
NUM_COORDINATES = 3
ROOT_JOINT = 0

NUM_EXERCISES = 10
NUM_CONDITIONS = 2

WEIGHTS_PATH = Path(__file__).with_name("best_egcn.pth")
ADJACENCY_PATH = Path(__file__).with_name("adjacency_matrix.npy")

EXERCISE_NAMES = [
    "Deep Squat",
    "Hurdle Step",
    "Inline Lunge",
    "Side Lunge",
    "Sit to Stand",
    "Standing Active Straight Leg Raise",
    "Standing Shoulder Abduction",
    "Standing Shoulder Extension",
    "Standing Shoulder Internal-External Rotation",
    "Standing Shoulder Scaption",
]

CONDITION_NAMES = ["Incorrect", "Correct"]

# UI-PRMD scale references the model was trained against.
UI_PRMD_LEFT_LEG_REFERENCE = 8.5328
UI_PRMD_RIGHT_LEG_REFERENCE = 8.0322
UI_PRMD_HIP_LEG_REFERENCE = (UI_PRMD_LEFT_LEG_REFERENCE + UI_PRMD_RIGHT_LEG_REFERENCE) / 2.0

UI_PRMD_LEFT_ARM_REFERENCE = 3.8
UI_PRMD_RIGHT_ARM_REFERENCE = 3.8
UI_PRMD_ARM_REFERENCE = (UI_PRMD_LEFT_ARM_REFERENCE + UI_PRMD_RIGHT_ARM_REFERENCE) / 2.0

ARM_JOINTS = [6, 7, 8, 9, 10, 11, 12, 13]
LEG_JOINTS = [14, 15, 16, 17, 18, 19, 20, 21]
CORE_JOINTS = [0, 1, 2, 3, 4, 5]

# 33-point BlazePose landmark indices — identical layout/order between the
# legacy mp.solutions.pose.PoseLandmark enum used by the original ml/ script
# and the Tasks Vision PoseLandmarker list used by pose_detection.py.
NOSE = 0
LEFT_EAR, RIGHT_EAR = 7, 8
LEFT_SHOULDER, RIGHT_SHOULDER = 11, 12
LEFT_ELBOW, RIGHT_ELBOW = 13, 14
LEFT_WRIST, RIGHT_WRIST = 15, 16
LEFT_INDEX, RIGHT_INDEX = 19, 20
LEFT_HIP, RIGHT_HIP = 23, 24
LEFT_KNEE, RIGHT_KNEE = 25, 26
LEFT_ANKLE, RIGHT_ANKLE = 27, 28
LEFT_FOOT_INDEX, RIGHT_FOOT_INDEX = 31, 32

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _xyz(landmarks: Sequence, index: int) -> np.ndarray:
    landmark = landmarks[index]
    return np.array([landmark.x, landmark.y, landmark.z], dtype=np.float32)


def _midpoint(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (a + b) / 2.0


def _safe_unit(vector: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(vector))
    if norm < 1e-6:
        return np.zeros(3, dtype=np.float32)
    return (vector / norm).astype(np.float32)


def mediapipe_to_22_joints(landmarks: Sequence | None) -> np.ndarray | None:
    """Convert one frame of 33 BlazePose landmarks into the 22-joint
    UI-PRMD-style skeleton the EGCN was trained on. Same joint order and
    construction as ``ml/scripts/mediapipe_to_egcn.py::mediapipe_to_22_joints``.
    """
    if not landmarks:
        return None

    nose = _xyz(landmarks, NOSE)
    left_ear = _xyz(landmarks, LEFT_EAR)
    right_ear = _xyz(landmarks, RIGHT_EAR)

    left_shoulder = _xyz(landmarks, LEFT_SHOULDER)
    right_shoulder = _xyz(landmarks, RIGHT_SHOULDER)

    left_elbow = _xyz(landmarks, LEFT_ELBOW)
    right_elbow = _xyz(landmarks, RIGHT_ELBOW)
    left_wrist = _xyz(landmarks, LEFT_WRIST)
    right_wrist = _xyz(landmarks, RIGHT_WRIST)
    left_index = _xyz(landmarks, LEFT_INDEX)
    right_index = _xyz(landmarks, RIGHT_INDEX)

    left_hip = _xyz(landmarks, LEFT_HIP)
    right_hip = _xyz(landmarks, RIGHT_HIP)

    left_knee = _xyz(landmarks, LEFT_KNEE)
    right_knee = _xyz(landmarks, RIGHT_KNEE)
    left_ankle = _xyz(landmarks, LEFT_ANKLE)
    right_ankle = _xyz(landmarks, RIGHT_ANKLE)

    left_foot = _xyz(landmarks, LEFT_FOOT_INDEX)
    right_foot = _xyz(landmarks, RIGHT_FOOT_INDEX)

    waist = _midpoint(left_hip, right_hip)
    chest = _midpoint(left_shoulder, right_shoulder)
    spine = _midpoint(waist, chest)

    neck_direction = _safe_unit(nose - chest)
    shoulder_width = float(np.linalg.norm(left_shoulder - right_shoulder))
    neck_offset = max(0.10 * shoulder_width, 1e-3)
    neck = chest + neck_direction * neck_offset

    head = _midpoint(left_ear, right_ear)
    head_tip = nose

    skeleton = np.array(
        [
            waist,           # 00 Waist
            spine,           # 01 Spine
            chest,           # 02 Chest
            neck,            # 03 Neck
            head,            # 04 Head
            head_tip,        # 05 Head Tip
            left_shoulder,   # 06 Left Collar
            left_elbow,      # 07 Left Upper Arm
            left_wrist,      # 08 Left Forearm
            left_index,      # 09 Left Hand
            right_shoulder,  # 10 Right Collar
            right_elbow,     # 11 Right Upper Arm
            right_wrist,     # 12 Right Forearm
            right_index,     # 13 Right Hand
            left_knee,       # 14 Left Upper Leg
            left_ankle,      # 15 Left Lower Leg
            left_foot,       # 16 Left Foot
            left_foot,       # 17 Left Leg Toes
            right_knee,      # 18 Right Upper Leg
            right_ankle,     # 19 Right Lower Leg
            right_foot,      # 20 Right Foot
            right_foot,      # 21 Right Leg Toes
        ],
        dtype=np.float32,
    )
    return skeleton


def _root_normalize_sequence(sequence: np.ndarray) -> np.ndarray:
    root = sequence[:, ROOT_JOINT:ROOT_JOINT + 1, :]
    return (sequence - root).astype(np.float32)


def _scale_sequence_to_ui_prmd(sequence: np.ndarray) -> np.ndarray:
    scaled = sequence.copy()

    left_leg_lengths = np.linalg.norm(sequence[:, 14, :] - sequence[:, ROOT_JOINT, :], axis=1)
    right_leg_lengths = np.linalg.norm(sequence[:, 18, :] - sequence[:, ROOT_JOINT, :], axis=1)
    leg_references = np.concatenate([left_leg_lengths, right_leg_lengths])
    leg_references = leg_references[leg_references > 1e-6]
    leg_scale = (UI_PRMD_HIP_LEG_REFERENCE / float(np.median(leg_references))) if len(leg_references) else 1.0

    left_arm_lengths = np.linalg.norm(sequence[:, 7, :] - sequence[:, 6, :], axis=1)
    right_arm_lengths = np.linalg.norm(sequence[:, 11, :] - sequence[:, 10, :], axis=1)
    arm_references = np.concatenate([left_arm_lengths, right_arm_lengths])
    arm_references = arm_references[arm_references > 1e-6]
    arm_scale = (UI_PRMD_ARM_REFERENCE / float(np.median(arm_references))) if len(arm_references) else leg_scale

    scaled[:, ARM_JOINTS, :] = sequence[:, ARM_JOINTS, :] * arm_scale
    scaled[:, LEG_JOINTS, :] = sequence[:, LEG_JOINTS, :] * leg_scale
    scaled[:, CORE_JOINTS, :] = sequence[:, CORE_JOINTS, :] * leg_scale
    return scaled.astype(np.float32)


def _prepare_sequence(frames: list[np.ndarray]) -> np.ndarray:
    sequence = np.asarray(frames, dtype=np.float32)
    if sequence.shape != (NUM_FRAMES, NUM_JOINTS, NUM_COORDINATES):
        raise ValueError(f"Expected ({NUM_FRAMES},{NUM_JOINTS},{NUM_COORDINATES}), got {sequence.shape}")

    sequence = _root_normalize_sequence(sequence)
    sequence = _scale_sequence_to_ui_prmd(sequence)
    # MediaPipe Z is a weak monocular depth estimate — dampen it because the
    # EGCN was trained on Kinect skeleton depth.
    sequence[:, :, 2] *= 0.4

    if not np.isfinite(sequence).all():
        raise ValueError("Sequence contains NaN or infinite values.")
    return sequence


class EGCNPredictor:
    """Loads the trained EGCN once and turns a rolling window of pose
    landmarks into an exercise + movement-condition prediction.

    Thread-safe and lazy: the (relatively large) model/weights are only
    loaded into memory the first time a prediction is actually requested,
    matching how ``pose_detection.py`` lazily creates its MediaPipe
    landmarker. A separate frame buffer is kept per ``session_id`` so
    multiple concurrent callers (e.g. more than one browser tab hitting
    ``/detect_pose``) don't corrupt each other's 64-frame window.
    """

    def __init__(self) -> None:
        self._model: EGCN | None = None
        self._load_lock = threading.Lock()
        self._buffers: dict[str, deque] = {}
        self._buffers_lock = threading.Lock()

    def _ensure_model(self) -> EGCN:
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is None:
                if not WEIGHTS_PATH.is_file():
                    raise FileNotFoundError(f"EGCN weights not found at '{WEIGHTS_PATH}'.")
                if not ADJACENCY_PATH.is_file():
                    raise FileNotFoundError(f"Adjacency matrix not found at '{ADJACENCY_PATH}'.")
                adjacency = torch.tensor(np.load(ADJACENCY_PATH), dtype=torch.float32)
                model = EGCN(adjacency=adjacency, num_exercises=NUM_EXERCISES, num_conditions=NUM_CONDITIONS)
                # weights_only=False: this checkpoint (backend/ml_egcn/best_egcn.pth,
                # bundled with this repo) predates PyTorch 2.6's default of
                # weights_only=True and contains a plain dict with numpy
                # scalars (epoch/loss bookkeeping) alongside the tensor
                # state_dict, which the strict unpickler rejects.
                checkpoint = torch.load(WEIGHTS_PATH, map_location=DEVICE, weights_only=False)
                state_dict = checkpoint["model_state_dict"] if "model_state_dict" in checkpoint else checkpoint
                model.load_state_dict(state_dict)
                model.to(DEVICE)
                model.eval()
                self._model = model
        return self._model

    def _buffer_for(self, session_id: str) -> deque:
        with self._buffers_lock:
            buffer = self._buffers.get(session_id)
            if buffer is None:
                buffer = deque(maxlen=NUM_FRAMES)
                self._buffers[session_id] = buffer
            return buffer

    def reset(self, session_id: str = "default") -> None:
        """Clear the frame buffer, e.g. when the person leaves the frame."""
        self._buffer_for(session_id).clear()

    def add_frame(self, landmarks: Sequence | None, session_id: str = "default") -> int:
        """Feed one frame of pose landmarks into the rolling buffer.

        Returns how many frames are currently buffered for this session.
        """
        skeleton = mediapipe_to_22_joints(landmarks)
        buffer = self._buffer_for(session_id)
        if skeleton is None:
            return len(buffer)
        buffer.append(skeleton)
        return len(buffer)

    def predict(self, session_id: str = "default") -> dict | None:
        """Run EGCN inference over the current buffer.

        Returns ``None`` if fewer than ``NUM_FRAMES`` frames have been
        collected yet for this session (matching the original script, which
        only starts predicting once its 64-frame deque is full).
        """
        buffer = self._buffer_for(session_id)
        if len(buffer) < NUM_FRAMES:
            return {"ready": False, "frames_collected": len(buffer), "frames_needed": NUM_FRAMES}

        model = self._ensure_model()
        sequence = _prepare_sequence(list(buffer))
        tensor = torch.tensor(sequence, dtype=torch.float32, device=DEVICE).unsqueeze(0)

        with torch.no_grad():
            exercise_logits, condition_logits = model(tensor)

        exercise_probabilities = torch.softmax(exercise_logits, dim=1)[0].detach().cpu().numpy()
        condition_probabilities = torch.softmax(condition_logits, dim=1)[0].detach().cpu().numpy()

        exercise_index = int(np.argmax(exercise_probabilities))
        condition_index = int(np.argmax(condition_probabilities))
        top3_indices = np.argsort(exercise_probabilities)[::-1][:3]

        return {
            "ready": True,
            "exercise": EXERCISE_NAMES[exercise_index],
            "exercise_id": exercise_index,
            "exercise_confidence": round(float(exercise_probabilities[exercise_index]), 4),
            "condition": CONDITION_NAMES[condition_index],
            "condition_id": condition_index,
            "condition_confidence": round(float(condition_probabilities[condition_index]), 4),
            "top3": [
                {"exercise": EXERCISE_NAMES[i], "confidence": round(float(exercise_probabilities[i]), 4)}
                for i in top3_indices
            ],
        }


# Module-level singleton, mirroring the `landmarker`/`analyzer`/`smoother`
# globals already used in pose_detection.py.
egcn_predictor = EGCNPredictor()
