import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml_egcn.inference import EGCNPredictor, NUM_FRAMES, mediapipe_to_22_joints


class FakeLandmark(SimpleNamespace):
    pass


def _standing_frame(t=0.0):
    """A rough 33-point standing-pose landmark list, with slight per-frame
    motion so a 64-frame buffer isn't perfectly static."""
    import math

    coords = {
        0: (0.5, 0.10), 7: (0.45, 0.12), 8: (0.55, 0.12),
        11: (0.40, 0.25), 12: (0.60, 0.25),
        13: (0.35, 0.40), 14: (0.65, 0.40),
        15: (0.30, 0.55), 16: (0.70, 0.55),
        19: (0.28, 0.58), 20: (0.72, 0.58),
        23: (0.42, 0.55), 24: (0.58, 0.55),
        25: (0.42, 0.75), 26: (0.58, 0.75),
        27: (0.42, 0.95), 28: (0.58, 0.95),
        31: (0.42, 1.00), 32: (0.58, 1.00),
    }
    landmarks = []
    for i in range(33):
        x, y = coords.get(i, (0.5, 0.5))
        x += 0.01 * math.sin(t / 5.0 + i)
        landmarks.append(FakeLandmark(x=x, y=y, z=0.0, visibility=0.95))
    return landmarks


class MediapipeToTwentyTwoJointsTests(unittest.TestCase):
    def test_returns_none_without_landmarks(self):
        self.assertIsNone(mediapipe_to_22_joints(None))

    def test_produces_22_joints_with_xyz(self):
        skeleton = mediapipe_to_22_joints(_standing_frame())
        self.assertEqual(skeleton.shape, (22, 3))


class EGCNPredictorTests(unittest.TestCase):
    def test_not_ready_until_buffer_full(self):
        predictor = EGCNPredictor()
        for t in range(NUM_FRAMES - 1):
            predictor.add_frame(_standing_frame(t), session_id="s1")
        result = predictor.predict(session_id="s1")
        self.assertFalse(result["ready"])
        self.assertEqual(result["frames_collected"], NUM_FRAMES - 1)

    def test_predicts_once_buffer_full(self):
        predictor = EGCNPredictor()
        for t in range(NUM_FRAMES):
            predictor.add_frame(_standing_frame(t), session_id="s1")
        result = predictor.predict(session_id="s1")
        self.assertTrue(result["ready"])
        self.assertIn("exercise", result)
        self.assertIn("condition", result)
        self.assertEqual(len(result["top3"]), 3)

    def test_sessions_are_independent(self):
        predictor = EGCNPredictor()
        for t in range(NUM_FRAMES):
            predictor.add_frame(_standing_frame(t), session_id="a")
        self.assertTrue(predictor.predict(session_id="a")["ready"])
        self.assertFalse(predictor.predict(session_id="b")["ready"])

    def test_reset_clears_buffer(self):
        predictor = EGCNPredictor()
        for t in range(NUM_FRAMES):
            predictor.add_frame(_standing_frame(t), session_id="s1")
        predictor.reset(session_id="s1")
        result = predictor.predict(session_id="s1")
        self.assertFalse(result["ready"])
        self.assertEqual(result["frames_collected"], 0)


if __name__ == "__main__":
    unittest.main()
