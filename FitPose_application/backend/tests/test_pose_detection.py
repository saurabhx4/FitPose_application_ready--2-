import math
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pose_detection import ExerciseAnalyzer


class FakeLandmark(SimpleNamespace):
    pass


class ExerciseAnalyzerTests(unittest.TestCase):
    def _make_point(self, x, y, visibility=0.9):
        return FakeLandmark(x=x, y=y, z=0.0, visibility=visibility)

    def _landmarks(self, *, knee_angle=90):
        def knee_points(angle_deg):
            radians = math.radians(angle_deg)
            hip = (-1.0, 0.0)
            knee = (0.0, 0.0)
            ankle = (math.cos(math.pi - radians), math.sin(math.pi - radians))
            return hip, knee, ankle

        left_hip, left_knee, left_ankle = knee_points(knee_angle)
        right_hip, right_knee, right_ankle = knee_points(knee_angle)
        landmarks = [self._make_point(0.0, 0.0) for _ in range(33)]
        landmarks[11] = self._make_point(-0.3, 0.2)
        landmarks[12] = self._make_point(0.3, 0.2)
        landmarks[13] = self._make_point(-0.2, 0.4)
        landmarks[14] = self._make_point(0.2, 0.4)
        landmarks[15] = self._make_point(-0.25, 0.55)
        landmarks[16] = self._make_point(0.25, 0.55)
        landmarks[23] = self._make_point(*left_hip)
        landmarks[24] = self._make_point(*right_hip)
        landmarks[25] = self._make_point(*left_knee)
        landmarks[26] = self._make_point(*right_knee)
        landmarks[27] = self._make_point(*left_ankle)
        landmarks[28] = self._make_point(*right_ankle)
        landmarks[0] = self._make_point(0.0, 0.9)
        return landmarks

    def test_squat_recommendation_uses_angle_thresholds(self):
        analyzer = ExerciseAnalyzer()
        landmarks = self._landmarks(knee_angle=125)

        analyzer.analyze(landmarks, exercise='squats')
        analyzer.analyze(landmarks, exercise='squats')
        result = analyzer.analyze(landmarks, exercise='squats')

        self.assertGreater(result['confidence_score'], 0.0)
        self.assertIn('joint_angles', result)
        self.assertTrue(any('knee depth' in issue.lower() for issue in result['detected_issues']))
        self.assertIn('knee', result['personalized_correction'].lower())

    def test_idle_pose_returns_no_exercise_detected(self):
        analyzer = ExerciseAnalyzer()
        landmarks = self._landmarks(knee_angle=170)
        result = analyzer.analyze(landmarks, exercise='squats')

        self.assertEqual(result['posture_status'], 'No exercise detected')
        self.assertEqual(result['feedback'], 'No exercise detected.')

    def test_requires_multiple_frames_to_activate_squat_feedback(self):
        analyzer = ExerciseAnalyzer()
        landmarks = self._landmarks(knee_angle=125)

        first_result = analyzer.analyze(landmarks, exercise='squats')
        second_result = analyzer.analyze(landmarks, exercise='squats')
        third_result = analyzer.analyze(landmarks, exercise='squats')

        self.assertEqual(first_result['posture_status'], 'No exercise detected')
        self.assertEqual(second_result['posture_status'], 'No exercise detected')
        self.assertEqual(third_result['posture_status'], 'Incorrect posture')


if __name__ == '__main__':
    unittest.main()
