"""FitPose EGCN integration.

This package brings the trained Enhanced Graph Convolutional Network (EGCN)
from the separate `ml/` training project into the FitPose Flask backend, so
`/detect_pose` can additionally return a data-driven exercise classification
and correct/incorrect movement-condition call alongside the existing
rule-based joint-angle analysis in ``pose_detection.py``.

Files in this folder are copied straight from the ml/ project (not
re-trained here):
- ``egcn.py``               -> ml/models/egcn.py (model architecture, unchanged)
- ``best_egcn.pth``         -> ml/models/best_egcn.pth (trained weights)
- ``adjacency_matrix.npy``  -> ml/processed/adjacency_matrix.npy (22-joint skeleton graph)

See ``inference.py`` for the MediaPipe -> UI-PRMD joint conversion and the
rolling 64-frame buffer that feeds the model, ported from
ml/scripts/mediapipe_to_egcn.py.
"""

from .inference import EGCNPredictor, egcn_predictor

__all__ = ["EGCNPredictor", "egcn_predictor"]
