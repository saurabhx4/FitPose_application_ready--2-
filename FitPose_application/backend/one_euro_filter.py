"""One Euro Filter: low-jitter, low-lag landmark smoothing.

https://cristal.univ-lille.fr/~casiez/1euro/ (Casiez, Roussel, Vogel 2012)

Mirrors src/js/oneEuroFilter.js so the server-rendered skeleton (drawn onto
frames in _draw_pose) and the browser's in-canvas skeleton behave the same
way: raw MediaPipe landmarks jitter a few pixels every frame even when the
person holds still, and a plain moving average trades that jitter for lag on
fast movement. The One Euro filter adapts per-landmark: heavy smoothing at
low velocity, opening up automatically as the landmark starts moving.
"""

from __future__ import annotations

import math


class _LowPassFilter:
    __slots__ = ("_initialized", "_value")

    def __init__(self) -> None:
        self._initialized = False
        self._value = 0.0

    def filter(self, value: float, alpha: float) -> float:
        if not self._initialized:
            self._value = value
            self._initialized = True
        else:
            self._value = alpha * value + (1 - alpha) * self._value
        return self._value

    @property
    def last(self) -> float:
        return self._value


class OneEuroFilter:
    """minCutoff: lower = more smoothing at low speed (less jitter, more lag).
    beta: higher = less lag at high speed (cutoff opens up faster with velocity).
    """

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.3, d_cutoff: float = 1.0) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x = _LowPassFilter()
        self._dx = _LowPassFilter()
        self._last_time_s: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt_seconds: float) -> float:
        tau = 1 / (2 * math.pi * cutoff)
        return 1 / (1 + tau / dt_seconds)

    def reset(self) -> None:
        self._x = _LowPassFilter()
        self._dx = _LowPassFilter()
        self._last_time_s = None

    def filter(self, value: float, timestamp_s: float) -> float:
        if self._last_time_s is None:
            self._last_time_s = timestamp_s
            self._x.filter(value, 1)
            self._dx.filter(0.0, 1)
            return value

        dt_seconds = timestamp_s - self._last_time_s
        self._last_time_s = timestamp_s
        if dt_seconds <= 0:
            dt_seconds = 1 / 30  # guard against duplicate/out-of-order timestamps

        derivative = (value - self._x.last) / dt_seconds
        edx = self._dx.filter(derivative, self._alpha(self.d_cutoff, dt_seconds))
        cutoff = self.min_cutoff + self.beta * abs(edx)
        return self._x.filter(value, self._alpha(cutoff, dt_seconds))


class PoseSmoother:
    """Smooths a full 33-point BlazePose landmark list frame-to-frame.

    x/y are normalized image-plane coordinates (small, high-frequency jitter
    matters most there). z is depth, which is noisier by nature and gets a
    slightly looser default. Visibility passes through unfiltered — smoothing
    a confidence score would just delay legitimate appear/disappear
    transitions.
    """

    def __init__(self, landmark_count: int = 33) -> None:
        self._fx = [OneEuroFilter(min_cutoff=0.8, beta=0.4) for _ in range(landmark_count)]
        self._fy = [OneEuroFilter(min_cutoff=0.8, beta=0.4) for _ in range(landmark_count)]
        self._fz = [OneEuroFilter(min_cutoff=0.8, beta=0.6) for _ in range(landmark_count)]

    def reset(self) -> None:
        for group in (self._fx, self._fy, self._fz):
            for filt in group:
                filt.reset()

    def smooth(self, landmarks, timestamp_s: float):
        smoothed = []
        for index, point in enumerate(landmarks):
            fx, fy, fz = self._fx[index], self._fy[index], self._fz[index]
            smoothed.append(
                type(
                    "SmoothedLandmark",
                    (),
                    {
                        "x": fx.filter(point.x, timestamp_s),
                        "y": fy.filter(point.y, timestamp_s),
                        "z": fz.filter(point.z, timestamp_s),
                        "visibility": point.visibility,
                    },
                )()
            )
        return smoothed
