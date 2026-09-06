// ===== One Euro Filter: low-jitter, low-lag landmark smoothing =====
// https://cristal.univ-lille.fr/~casiez/1euro/ (Casiez, Roussel, Vogel 2012)
//
// Raw MediaPipe landmarks jitter a few pixels every frame even when the
// person is holding still, which makes the on-screen skeleton look shaky
// and injects noise into joint-angle math. A plain moving average removes
// the jitter but adds visible lag on fast movement (e.g. the bottom of a
// squat). The One Euro filter adapts: it smooths hard when the landmark is
// nearly still and lightens up automatically as velocity increases, so the
// skeleton looks stable when static and stays responsive when moving.

class LowPassFilter {
  constructor() {
    this._initialized = false;
    this._value = 0;
  }
  filter(value, alpha) {
    if (!this._initialized) {
      this._value = value;
      this._initialized = true;
    } else {
      this._value = alpha * value + (1 - alpha) * this._value;
    }
    return this._value;
  }
  get last() {
    return this._value;
  }
}

class OneEuroFilter {
  // minCutoff: lower = more smoothing at low speed (less jitter, more lag).
  // beta: higher = less lag at high speed (cutoff opens up faster with velocity).
  constructor({ minCutoff = 1.0, beta = 0.3, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._x = new LowPassFilter();
    this._dx = new LowPassFilter();
    this._lastTimeMs = null;
  }

  _alpha(cutoff, dtSeconds) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSeconds);
  }

  filter(value, timestampMs) {
    if (this._lastTimeMs == null) {
      this._lastTimeMs = timestampMs;
      this._x.filter(value, 1);
      this._dx.filter(0, 1);
      return value;
    }
    let dtSeconds = (timestampMs - this._lastTimeMs) / 1000;
    this._lastTimeMs = timestampMs;
    if (!(dtSeconds > 0)) dtSeconds = 1 / 30; // guard against duplicate/out-of-order timestamps

    const derivative = (value - this._x.last) / dtSeconds;
    const edx = this._dx.filter(derivative, this._alpha(this.dCutoff, dtSeconds));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this._x.filter(value, this._alpha(cutoff, dtSeconds));
  }
}

// Smooths a full 33-point BlazePose landmark array frame-to-frame.
// x/y/z each get their own filter per landmark index; visibility/presence
// pass through unfiltered (smoothing a confidence score would just delay
// legitimate appear/disappear transitions).
export class PoseSmoother {
  constructor(landmarkCount = 33, options = {}) {
    // x/y are normalized image-plane coordinates (small, high-frequency
    // jitter matters most here). z is depth, which is noisier and coarser
    // by nature, so it gets a slightly looser default.
    const xy = { minCutoff: 0.8, beta: 0.4, dCutoff: 1.0, ...options.xy };
    const z = { minCutoff: 0.8, beta: 0.6, dCutoff: 1.0, ...options.z };
    this._fx = Array.from({ length: landmarkCount }, () => new OneEuroFilter(xy));
    this._fy = Array.from({ length: landmarkCount }, () => new OneEuroFilter(xy));
    this._fz = Array.from({ length: landmarkCount }, () => new OneEuroFilter(z));
  }

  reset() {
    for (const arr of [this._fx, this._fy, this._fz]) {
      for (const filter of arr) {
        filter._lastTimeMs = null;
        filter._x._initialized = false;
        filter._dx._initialized = false;
      }
    }
  }

  smooth(landmarks, timestampMs) {
    if (!landmarks) return landmarks;
    return landmarks.map((point, index) => {
      if (!point) return point;
      const fx = this._fx[index] || (this._fx[index] = new OneEuroFilter());
      const fy = this._fy[index] || (this._fy[index] = new OneEuroFilter());
      const fz = this._fz[index] || (this._fz[index] = new OneEuroFilter());
      return {
        x: fx.filter(point.x, timestampMs),
        y: fy.filter(point.y, timestampMs),
        z: fz.filter(point.z || 0, timestampMs),
        visibility: point.visibility ?? 0,
      };
    });
  }
}

export { OneEuroFilter };
