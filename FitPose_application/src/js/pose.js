// ===== Real, in-browser pose detection (mirrors backend/pose_detection.py) =====
// Uses Google's MediaPipe Tasks Vision PoseLandmarker running entirely on-device —
// no server upload, no Python backend required. The model is bundled locally
// while the MediaPipe runtime/WASM is loaded lazily from the CDN.

import { PoseSmoother } from './oneEuroFilter.js';

let visionModule = null;
let landmarkerInstance = null;
let activeModelUrl = null;

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

// MediaPipe ships three BlazePose checkpoints, trading latency for accuracy:
//   lite  (~3MB)  — fastest, lowest landmark precision.
//   full  (~6MB)  — noticeably more accurate joint positions, still real-time
//                   on most laptops/phones.
//   heavy (~26MB) — the most precise skeleton, best for a still/near-static
//                   camera; can drop below real-time on weaker devices.
// Only the lite model ships in this repo by default. To get a more precise
// skeleton, download one of the others from Google's model zoo and drop it
// in /public/models/, then set VITE_POSE_MODEL_TIER=full (or "heavy") in
// your .env — no code changes needed:
//   full:  https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task
//   heavy: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
const MODEL_FILES = {
  lite: 'pose_landmarker_lite.task',
  full: 'pose_landmarker_full.task',
  heavy: 'pose_landmarker_heavy.task',
};
const REQUESTED_TIER = (import.meta.env?.VITE_POSE_MODEL_TIER || 'lite').toLowerCase();

async function resolveModelUrl(onStatus) {
  const order = REQUESTED_TIER === 'heavy'
    ? ['heavy', 'full', 'lite']
    : REQUESTED_TIER === 'full'
    ? ['full', 'lite']
    : ['lite'];
  for (const tier of order) {
    const url = `/models/${MODEL_FILES[tier]}`;
    try {
      // HEAD check so we fail fast onto the next tier instead of letting
      // PoseLandmarker.createFromOptions throw deep inside the WASM runtime.
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) {
        if (tier !== 'lite') onStatus?.(`Loading ${tier} model…`);
        return url;
      }
    } catch {
      // network hiccup or file missing — try the next tier down.
    }
  }
  return `/models/${MODEL_FILES.lite}`;
}

// Back at MediaPipe's 0.5 defaults (matches backend/pose_detection.py).
// The previous 0.6/0.6/0.65 floors were meant to cut jitter but ended up
// rejecting whole-body frames too often — legs/feet in particular, or
// anyone not perfectly centered/fully framed — which is what showed up on
// screen as a partial, upper-body-only skeleton instead of full-body
// coverage. Jitter is now handled by the 0.3 per-landmark draw threshold
// in drawPoseOverlay() plus the One-Euro smoother, not by starving the
// detector.
const DETECTOR_THRESHOLDS = {
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
};

export async function loadPoseLandmarker(onStatus) {
  if (landmarkerInstance) return landmarkerInstance;
  onStatus?.('Loading AI model…');
  const { FilesetResolver, PoseLandmarker } = await import(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
  );
  visionModule = { FilesetResolver, PoseLandmarker };
  const filesetResolver = await FilesetResolver.forVisionTasks(WASM_BASE);
  const modelUrl = await resolveModelUrl(onStatus);
  activeModelUrl = modelUrl;
  landmarkerInstance = await PoseLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numPoses: 1,
    ...DETECTOR_THRESHOLDS,
  }).catch(async () => {
    // GPU delegate can fail on some devices/browsers — retry on CPU.
    return PoseLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      ...DETECTOR_THRESHOLDS,
    });
  });
  onStatus?.(null);
  return landmarkerInstance;
}

export function getActiveModelUrl() {
  return activeModelUrl;
}

// One smoother instance per landmarker lifetime — reset alongside it so a
// re-opened camera session doesn't inherit stale velocity estimates.
const smoother = new PoseSmoother(33);

// 33-point BlazePose landmark indices used for joint-angle analysis.
const L = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
};

export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21],
  [17, 19], [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

function angle(a, vertex, c) {
  const v1 = { x: a.x - vertex.x, y: a.y - vertex.y };
  const v2 = { x: c.x - vertex.x, y: c.y - vertex.y };
  const l1 = Math.hypot(v1.x, v1.y);
  const l2 = Math.hypot(v2.x, v2.y);
  if (!l1 || !l2) return 0;
  const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
  return Math.round((Math.acos(cos) * 180) / Math.PI * 10) / 10;
}
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2, visibility: ((a.visibility || 0) + (b.visibility || 0)) / 2 };
}


const EXERCISE_ALIASES = {
  squat: 'squats', squats: 'squats',
  'push-up': 'push-up', pushup: 'push-up',
  plank: 'plank',
  'shoulder-raise': 'shoulder-raise', 'shoulder-raises': 'shoulder-raise',
  'knee-bend': 'knee-bend', 'neck-stretch': 'neck-stretch',
  'hip-rotation': 'hip-rotation', 'cat-cow': 'cat-cow', 'hip-flexor': 'hip-flexor',

  // A01–A10 are deliberately explicit. Never fall back to "squats":
  // each exercise has its own rep signal/state machine.
  'a01-deep-squat': 'a01-deep-squat',
  'a02-hurdle-step': 'a02-hurdle-step',
  'a03-inline-lunge': 'a03-inline-lunge',
  'a04-side-lunge': 'a04-side-lunge',
  'a05-sit-to-stand': 'a05-sit-to-stand',
  'a06-standing-active-straight-leg-raise': 'a06-standing-active-straight-leg-raise',
  'a07-standing-shoulder-abduction': 'a07-standing-shoulder-abduction',
  'a08-standing-shoulder-extension': 'a08-standing-shoulder-extension',
  'a09-standing-shoulder-internal-external-rotation': 'a09-standing-shoulder-internal-external-rotation',
  'a09-standing-shoulder-internal–external-rotation': 'a09-standing-shoulder-internal-external-rotation',
  'a10-standing-shoulder-scaption': 'a10-standing-shoulder-scaption',
};
function normalizeExercise(ex) {
  if (!ex) return 'squats';
  const key = String(ex).trim().toLowerCase().replace(/\s+/g, '-');
  return EXERCISE_ALIASES[key] || EXERCISE_ALIASES[key.replace(/a(\d)\b/, 'a0$1')] || 'squats';
}

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function signedArmElevation(shoulder, wrist, hip) {
  // 0° = arm hanging beside the body; positive = raised away from the body.
  const vx = wrist.x - shoulder.x;
  const vy = wrist.y - shoulder.y;
  const dx = hip.x - shoulder.x;
  const dy = hip.y - shoulder.y;
  const cross = dx * vy - dy * vx;
  const dot = dx * vx + dy * vy;
  const a = Math.atan2(Math.abs(cross), dot) * 180 / Math.PI;
  return Math.max(0, Math.min(180, a));
}
function hipHeightRatio(lm) {
  const shoulder = midpoint(lm[L.L_SHOULDER], lm[L.R_SHOULDER]);
  const hip = midpoint(lm[L.L_HIP], lm[L.R_HIP]);
  const ankle = midpoint(lm[L.L_ANKLE], lm[L.R_ANKLE]);
  const total = Math.max(0.05, distance2D(shoulder, ankle));
  return (hip.y - shoulder.y) / total;
}
function legStraightness(knee, hip, ankle) {
  return angle(hip, knee, ankle);
}
function lateralStance(lm) {
  const shoulderWidth = Math.max(0.03, distance2D(lm[L.L_SHOULDER], lm[L.R_SHOULDER]));
  return distance2D(lm[L.L_ANKLE], lm[L.R_ANKLE]) / shoulderWidth;
}
function lineAngleFromHorizontal(start, end) {
  // A perfectly upright line is 90 degrees from the horizontal.  Taking the
  // absolute components makes a left and right neck tilt behave identically.
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  return Math.round(Math.atan2(dy, dx) * 180 / Math.PI * 10) / 10;
}

export class ExerciseAnalyzer {
  constructor() { this.reset(); }

  reset() {
    this.repCount = 0;
    this.phase = 'neutral';
    this._exerciseConfidence = 0;
    this._activeExercise = null;
    this._sessionState = 'idle';
    this._smoothed = {};
    this._stableFrames = 0;
    this._lastRepAt = 0;
    this._mobilitySide = null;
    this._sidePhase = { left: 'neutral', right: 'neutral' };
    this._sideBest = { left: 0, right: 0 };
    this._lastTimestamp = 0;
    this._validFrames = 0;
  }

  _jointAngles(lm) {
    const shoulderMid = midpoint(lm[L.L_SHOULDER], lm[L.R_SHOULDER]);
    const hipMid = midpoint(lm[L.L_HIP], lm[L.R_HIP]);
    const kneeMid = midpoint(lm[L.L_KNEE], lm[L.R_KNEE]);
    // Upper-neck point (matches the synthetic dot drawn in app.js): halfway
    // between the nose and the shoulder midpoint. Wiring it to both
    // shoulders individually — instead of only using nose/shoulderMid/hipMid
    // for forward flexion like `neck` below — is what lets lateral tilt and
    // rotation actually be measured, since a sideways head tilt shifts this
    // point off-center between the shoulders in a way shoulderMid alone
    // can't capture.
    const neckBase = midpoint(lm[L.NOSE], shoulderMid);
    const shoulderWidth = Math.hypot(lm[L.R_SHOULDER].x - lm[L.L_SHOULDER].x, lm[L.R_SHOULDER].y - lm[L.L_SHOULDER].y) || 1;
    return {
      left_elbow: angle(lm[L.L_SHOULDER], lm[L.L_ELBOW], lm[L.L_WRIST]),
      right_elbow: angle(lm[L.R_SHOULDER], lm[L.R_ELBOW], lm[L.R_WRIST]),
      left_shoulder: angle(lm[L.L_ELBOW], lm[L.L_SHOULDER], lm[L.L_HIP]),
      right_shoulder: angle(lm[L.R_ELBOW], lm[L.R_SHOULDER], lm[L.R_HIP]),
      left_hip: angle(lm[L.L_SHOULDER], lm[L.L_HIP], lm[L.L_KNEE]),
      right_hip: angle(lm[L.R_SHOULDER], lm[L.R_HIP], lm[L.R_KNEE]),
      left_knee: angle(lm[L.L_HIP], lm[L.L_KNEE], lm[L.L_ANKLE]),
      right_knee: angle(lm[L.R_HIP], lm[L.R_KNEE], lm[L.R_ANKLE]),
      back: angle(shoulderMid, hipMid, kneeMid),
      neck: angle(shoulderMid, lm[L.NOSE], hipMid),
      // Lateral neck tilt/rotation, derived from neckBase (see above) rather
      // than the nose alone, so it stays stable as the head turns and not
      // just when it bends forward/back like `neck` does.
      neck_tilt: angle(lm[L.L_SHOULDER], neckBase, lm[L.R_SHOULDER]),
      // Signed, shoulder-width-normalized offset of neckBase from center:
      // ~0 when the head is centered, positive/negative as it leans toward
      // the right/left shoulder. More directly readable than neck_tilt for
      // telling which side the tilt is toward and by how much.
      neck_lateral_offset: Math.round(((neckBase.x - shoulderMid.x) / shoulderWidth) * 1000) / 1000,
      // Centerline from the shoulder midpoint to the nose.  This is the
      // vertical neck line visible in the camera overlay: upright is ~90deg;
      // it decreases equally for a left or right lateral neck stretch.
      neck_vertical_angle: lineAngleFromHorizontal(shoulderMid, lm[L.NOSE]),
      left_arm_elevation: signedArmElevation(lm[L.L_SHOULDER], lm[L.L_WRIST], lm[L.L_HIP]),
      right_arm_elevation: signedArmElevation(lm[L.R_SHOULDER], lm[L.R_WRIST], lm[L.R_HIP]),
      stance_width: lateralStance(lm),
      hip_height_ratio: hipHeightRatio(lm),
    };
  }

  _relevant(key) {
    return {
      'a01-deep-squat': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'a02-hurdle-step': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'a03-inline-lunge': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'a04-side-lunge': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'a05-sit-to-stand': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'a06-standing-active-straight-leg-raise': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'a07-standing-shoulder-abduction': [L.L_SHOULDER,L.R_SHOULDER,L.L_ELBOW,L.R_ELBOW,L.L_WRIST,L.R_WRIST],
      'a08-standing-shoulder-extension': [L.L_SHOULDER,L.R_SHOULDER,L.L_ELBOW,L.R_ELBOW,L.L_WRIST,L.R_WRIST],
      'a09-standing-shoulder-internal-external-rotation': [L.L_SHOULDER,L.R_SHOULDER,L.L_ELBOW,L.R_ELBOW,L.L_WRIST,L.R_WRIST],
      'a10-standing-shoulder-scaption': [L.L_SHOULDER,L.R_SHOULDER,L.L_ELBOW,L.R_ELBOW,L.L_WRIST,L.R_WRIST],
      squats: [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'push-up': [L.L_SHOULDER,L.R_SHOULDER,L.L_ELBOW,L.R_ELBOW,L.L_WRIST,L.R_WRIST,L.L_HIP,L.R_HIP],
      plank: [L.L_SHOULDER,L.R_SHOULDER,L.L_HIP,L.R_HIP,L.L_ANKLE,L.R_ANKLE],
      'shoulder-raise': [L.L_SHOULDER,L.R_SHOULDER,L.L_ELBOW,L.R_ELBOW,L.L_WRIST,L.R_WRIST],
      'cat-cow': [L.L_SHOULDER,L.R_SHOULDER,L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE],
      'hip-flexor': [L.L_SHOULDER,L.R_SHOULDER,L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE],
      'knee-bend': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
      'neck-stretch': [L.NOSE,L.L_SHOULDER,L.R_SHOULDER],
      'hip-rotation': [L.L_HIP,L.R_HIP,L.L_KNEE,L.R_KNEE,L.L_ANKLE,L.R_ANKLE],
    }[key] || [L.L_SHOULDER,L.R_SHOULDER,L.L_HIP,L.R_HIP];
  }

  _visible(lm, indices, threshold=0.52) {
    const n = indices.filter(i => (lm[i]?.visibility ?? 0) >= threshold).length;
    // A neck stretch deliberately has only nose + two shoulders as relevant
    // landmarks, so never demand more visible points than the exercise has.
    return n >= Math.min(indices.length, Math.max(4, Math.ceil(indices.length * 0.75)));
  }

  _confidenceScore(lm, angles, key) {
    const rel = this._relevant(key);
    const visibility = rel.reduce((s,i) => s + (lm[i]?.visibility ?? 0), 0) / rel.length;
    const symmetryPenalty = (Math.min(1, Math.abs(angles.left_knee-angles.right_knee)/100) +
                             Math.min(1, Math.abs(angles.left_shoulder-angles.right_shoulder)/100)) / 2;
    return Math.max(0, Math.min(1, 0.82*visibility + 0.18*(1-symmetryPenalty)));
  }

  _smooth(name, value, alpha=0.22) {
    if (!Number.isFinite(value)) return this._smoothed[name] ?? 0;
    const old = this._smoothed[name];
    this._smoothed[name] = old == null ? value : old + alpha*(value-old);
    return this._smoothed[name];
  }

  _canCount() {
    return Date.now() - this._lastRepAt >= 420;
  }

  _markRep(side=null) {
    if (!this._canCount()) return false;
    this.repCount++;
    this._lastRepAt = Date.now();
    this._mobilitySide = side || this._mobilitySide;
    return true;
  }

  _cycle(signal, down, up, minRange=0) {
    if (!Number.isFinite(signal)) return false;
    if (this.phase === 'neutral' && signal >= up) this.phase = 'up';
    if (this.phase === 'up' && signal <= down) {
      this.phase = 'down';
      return false;
    }
    if (this.phase === 'down' && signal >= up && (up-down) >= minRange) {
      if (!this._canCount()) return false;
      this.phase = 'up';
      return this._markRep();
    }
    return false;
  }

  _sideCycle(side, signal, activeThreshold, neutralThreshold) {
    const phase = this._sidePhase[side];
    if (phase === 'neutral') {
      if (signal >= activeThreshold) this._sidePhase[side] = 'active';
      return false;
    }
    if (phase === 'active' && signal <= neutralThreshold) {
      this._sidePhase[side] = 'neutral';
      return this._markRep(side);
    }
    return false;
  }

  _analyzeA01(lm,a) {
    const knee = this._smooth('a01_knee',(a.left_knee+a.right_knee)/2);
    return this._cycle(knee, 108, 158);
  }

  _analyzeA02(lm,a) {
    // A hurdle-step rep = one leg clears the hurdle and returns to the floor.
    // Use normalized ankle lift + knee flexion, not generic knee angle alone.
    const hipL=lm[L.L_HIP], hipR=lm[L.R_HIP], anL=lm[L.L_ANKLE], anR=lm[L.R_ANKLE];
    const legL=Math.max(.08,distance2D(hipL,lm[L.L_KNEE])+distance2D(lm[L.L_KNEE],anL));
    const legR=Math.max(.08,distance2D(hipR,lm[L.R_KNEE])+distance2D(lm[L.R_KNEE],anR));
    // In a hurdle step the knee, not the ankle, is the reliable "clearing"
    // marker. Use the opposite foot as the floor reference so the metric
    // works when the lifted foot is forward rather than vertically above hip.
    const liftL=(anR.y-lm[L.L_KNEE].y)/legL;
    const liftR=(anL.y-lm[L.R_KNEE].y)/legR;
    const sigL=Math.max(liftL,0) + Math.max(0,145-a.left_knee)/260;
    const sigR=Math.max(liftR,0) + Math.max(0,145-a.right_knee)/260;
    if (sigL > sigR) {
      return this._sideCycle('left',sigL,0.36,0.16);
    }
    if (sigR > sigL) {
      return this._sideCycle('right',sigR,0.36,0.16);
    }
    return false;
  }

  _analyzeA03(lm,a) {
    const knee=this._smooth('a03_knee',Math.min(a.left_knee,a.right_knee));
    return this._cycle(knee, 115, 158);
  }

  _analyzeA04(lm,a) {
    const width=this._smooth('a04_width',a.stance_width);
    const knee=this._smooth('a04_knee',Math.min(a.left_knee,a.right_knee));
    // Require a lateral stance so ordinary squats cannot trigger A04.
    const signal = width >= 1.28 ? knee : 180;
    return this._cycle(signal, 125, 158);
  }

  _analyzeA05(lm,a) {
    // Sit-to-stand requires BOTH a clear knee bend and a substantial hip drop.
    const knee=this._smooth('a05_knee',Math.min(a.left_knee,a.right_knee));
    const hip=this._smooth('a05_hip',a.hip_height_ratio);
    if (this.phase==='neutral') {
      if (hip >= 0.64 && knee <= 145) this.phase='down';
      return false;
    }
    if (this.phase==='down' && knee >= 155 && hip <= 0.59) {
      this.phase='up';
      return this._markRep();
    }
    return false;
  }

  _analyzeA06(lm,a) {
    const shoulderWidth=Math.max(.04,distance2D(lm[L.L_SHOULDER],lm[L.R_SHOULDER]));
    const candidates=[];
    for (const side of ['left','right']) {
      const hip=lm[side==='left'?L.L_HIP:L.R_HIP];
      const knee=lm[side==='left'?L.L_KNEE:L.R_KNEE];
      const ankle=lm[side==='left'?L.L_ANKLE:L.R_ANKLE];
      const k=side==='left'?a.left_knee:a.right_knee;
      const leg=Math.max(.08,distance2D(hip,knee)+distance2D(knee,ankle));
      // Compare the moving ankle with the opposite (standing) ankle.
      // This captures a forward straight-leg raise even when the raised
      // ankle is still below the hip on screen.
      const otherAnkle=side==='left'?lm[L.R_ANKLE]:lm[L.L_ANKLE];
      const lift=(otherAnkle.y-ankle.y)/leg;
      // Straight knee + meaningful lift; bent-knee raises are rejected.
      const signal=Math.max(0,lift-0.18) + Math.max(0,k-150)/160;
      candidates.push([side,signal,k]);
    }
    const [side,signal,k]=candidates.sort((x,y)=>y[1]-x[1])[0];
    // Require the lifted leg to stay straight; otherwise knee raises don't count.
    if (k < 150) return false;
    return this._sideCycle(side,signal,0.55,0.20);
  }

  _analyzeA07(lm,a) {
    const sig=this._smooth('a07_elev',(a.left_arm_elevation+a.right_arm_elevation)/2);
    return this._cycle(sig,20,72);
  }

  _analyzeA08(lm,a) {
    // Extension is sagittal: use wrist depth (z) and the arm's angle from
    // the downward torso axis. This avoids treating abduction as extension.
    const shL=lm[L.L_SHOULDER], shR=lm[L.R_SHOULDER];
    const wL=lm[L.L_WRIST], wR=lm[L.R_WRIST];
    const zL=(wL.z-shL.z), zR=(wR.z-shR.z);
    const width=Math.max(.04,distance2D(shL,shR));
    const depth=Math.max(zL,zR)/width;
    const elev=Math.max(a.left_arm_elevation,a.right_arm_elevation);
    const xSpread=Math.max(Math.abs(wL.x-shL.x),Math.abs(wR.x-shR.x))/width;
    // Extension is primarily backward with limited lateral spread. This
    // prevents a normal shoulder-abduction rep from being counted as A08.
    const sagittal=Math.max(0,depth*2.2) + Math.max(0,elev-8)/110;
    const gated=sagittal*(xSpread<0.70?1:0.35);
    const sig=this._smooth('a08_ext',gated);
    return this._cycle(sig,0.10,0.38);
  }

  _analyzeA09(lm,a) {
    // Frontal-camera robust rotation proxy: elbows remain near the ribs and
    // wrists move laterally around the elbows. Both directions must occur:
    // neutral -> external -> neutral/internal -> neutral = one rep.
    const shW=Math.max(.04,distance2D(lm[L.L_SHOULDER],lm[L.R_SHOULDER]));
    const l=(lm[L.L_ELBOW].x-lm[L.L_WRIST].x)/shW;
    const r=(lm[L.R_WRIST].x-lm[L.R_ELBOW].x)/shW;
    const outward=(l+r)/2;
    const inward=-outward;
    if (this.phase==='neutral') {
      if (outward >= 0.16) this.phase='external';
      else if (inward >= 0.16) this.phase='internal';
      return false;
    }
    if (this.phase==='external' && inward >= 0.16) {
      this.phase='internal';
      return false;
    }
    if (this.phase==='internal' && Math.abs(outward) < 0.10) {
      this.phase='neutral';
      return this._markRep();
    }
    return false;
  }

  _analyzeA10(lm,a) {
    const sig=this._smooth('a10_elev',(a.left_arm_elevation+a.right_arm_elevation)/2);
    return this._cycle(sig,18,62);
  }

  _analyzeNeckStretch(lm,a) {
    const tilt = this._smooth('neck_vertical_angle', a.neck_vertical_angle, 0.28);
    // The vertical neck line is ~90deg when upright.  Arm the next repetition
    // only after returning near neutral, then count once it drops below 70deg.
    // The 10deg gap prevents jitter at the threshold from double-counting.
    if (this.phase === 'neutral' && tilt >= 80) {
      this.phase = 'ready';
      return false;
    }
    if (this.phase === 'ready' && tilt < 70) {
      this.phase = 'tilted';
      return this._markRep();
    }
    if (this.phase === 'tilted' && tilt >= 80) this.phase = 'ready';
    return false;
  }

  _legacy(key,lm,a) {
    const knee=this._smooth('legacy_knee',(a.left_knee+a.right_knee)/2);
    const elbow=this._smooth('legacy_elbow',(a.left_elbow+a.right_elbow)/2);
    const shoulder=this._smooth('legacy_shoulder',(a.left_shoulder+a.right_shoulder)/2);
    const back=this._smooth('legacy_back',a.back);
    if (key==='squats'||key==='knee-bend') return this._cycle(knee,112,158);
    if (key==='push-up') return this._cycle(elbow,105,150);
    if (key==='shoulder-raise') return this._cycle(shoulder,38,78);
    if (key==='cat-cow') return this._cycle(back,145,164);
    if (key==='hip-flexor') return this._cycle(Math.min(a.left_hip,a.right_hip),105,145);
    return false;
  }

  _count(key,lm,a) {
    if (key==='a01-deep-squat') return this._analyzeA01(lm,a);
    if (key==='a02-hurdle-step') return this._analyzeA02(lm,a);
    if (key==='a03-inline-lunge') return this._analyzeA03(lm,a);
    if (key==='a04-side-lunge') return this._analyzeA04(lm,a);
    if (key==='a05-sit-to-stand') return this._analyzeA05(lm,a);
    if (key==='a06-standing-active-straight-leg-raise') return this._analyzeA06(lm,a);
    if (key==='a07-standing-shoulder-abduction') return this._analyzeA07(lm,a);
    if (key==='a08-standing-shoulder-extension') return this._analyzeA08(lm,a);
    if (key==='a09-standing-shoulder-internal-external-rotation') return this._analyzeA09(lm,a);
    if (key==='a10-standing-shoulder-scaption') return this._analyzeA10(lm,a);
    if (key==='neck-stretch') return this._analyzeNeckStretch(lm,a);
    return this._legacy(key,lm,a);
  }

  _issues(key,lm,a) {
    const issues=[]; const corrections=[]; const add=(i,c)=>{issues.push(i);corrections.push(c);};
    const knee=(a.left_knee+a.right_knee)/2;
    const shoulder=(a.left_arm_elevation+a.right_arm_elevation)/2;
    if (key==='a01-deep-squat') {
      if(knee>120)add(`Squat depth is shallow (${knee.toFixed(0)}°).`,'Lower with control while keeping heels grounded.');
      if(Math.abs(a.left_knee-a.right_knee)>18)add('Knees are moving unevenly.','Keep both knees tracking over the feet.');
    } else if(key==='a02-hurdle-step') {
      if(Math.abs(a.left_hip-a.right_hip)>20)add('Hips are shifting unevenly.','Keep the pelvis level while stepping over the hurdle.');
    } else if(key==='a03-inline-lunge') {
      if(knee>125)add('Lunge depth is shallow.','Bend both knees comfortably while staying tall.');
      if(Math.abs(a.left_knee-a.right_knee)>28)add('Front and rear legs are uneven.','Keep the front knee aligned over the foot.');
    } else if(key==='a04-side-lunge') {
      if(a.stance_width<1.28)add('Step wider for the side lunge.','Take a clear lateral step before lowering.');
    } else if(key==='a05-sit-to-stand') {
      if(a.hip_height_ratio<0.61 && knee>145)add('Sit back fully before standing.','Use the chair as the depth reference and move slowly.');
    } else if(key==='a06-standing-active-straight-leg-raise') {
      if(Math.min(a.left_knee,a.right_knee)<145)add('Keep the raised knee straight.','Lift from the hip without bending the knee.');
    } else if(key==='a07-standing-shoulder-abduction') {
      if(shoulder<55)add('Arms are below the target range.','Raise the arms smoothly toward shoulder height.');
      if(Math.abs(a.left_arm_elevation-a.right_arm_elevation)>18)add('Arms are uneven.','Raise both arms at the same pace.');
    } else if(key==='a08-standing-shoulder-extension') {
      if(shoulder>65)add('Avoid lifting the arms upward.','Move the arms backward from the shoulders, not up.');
    } else if(key==='a09-standing-shoulder-internal-external-rotation') {
      const elb=Math.max(distance2D(lm[L.L_ELBOW],lm[L.L_HIP]),distance2D(lm[L.R_ELBOW],lm[L.R_HIP]));
      if(elb>0.28)add('Keep your elbows close to your sides.','Stabilize the upper arms and rotate only at the shoulders.');
    } else if(key==='a10-standing-shoulder-scaption') {
      if(shoulder<50)add('Raise the arms into the scaption range.','Lift diagonally forward toward shoulder height.');
      if(shoulder>105)add('Do not shrug or over-raise.','Stop around shoulder height and keep your neck relaxed.');
    } else if(key==='neck-stretch') {
      if(a.neck_vertical_angle>=70)add(`Tilt your head farther to the side (${a.neck_vertical_angle.toFixed(0)}deg).`,'Gently bring your ear closer to your shoulder.');
    }
    return {issues,corrections};
  }

  analyze(landmarks, exercise) {
    const key=normalizeExercise(exercise);
    if(!landmarks || landmarks.length<33) {
      this._stableFrames=0; this._sessionState='idle';
      return {
        rep_count:this.repCount, posture_status:'No exercise detected', accuracy:0,
        feedback:'Step into frame so FitPose AI can see your full body.',
        detected_issues:['No person detected'], issue_codes:[], joint_angles:{},
        confidence_score:0, personalized_correction:'Stand far enough back for your full body to be visible.',
        session_state:'idle', exercise_key:key, landmarks:[], rep_just_counted:false
      };
    }

    const rel=this._relevant(key);
    if(!this._visible(landmarks,rel)) {
      this._stableFrames=0; this._sessionState='idle';
      return {
        rep_count:this.repCount, posture_status:'No exercise detected', accuracy:0,
        feedback:'Keep your full body and the moving joints inside the camera frame.',
        detected_issues:['Waiting for a clear full-body pose'], issue_codes:[],
        joint_angles:this._jointAngles(landmarks), confidence_score:0,
        personalized_correction:'Move the camera back or improve lighting so all required joints are visible.',
        session_state:'idle', exercise_key:key,
        landmarks:landmarks.map(p=>({x:p.x,y:p.y,z:p.z||0,visibility:p.visibility??0})),
        rep_just_counted:false
      };
    }

    this._stableFrames++;
    this._sessionState=this._stableFrames>=8?'active':'starting';
    if(this._sessionState!=='active') {
      return {
        rep_count:this.repCount, posture_status:'No exercise detected', accuracy:0,
        feedback:'Hold still for a moment so FitPose can lock onto your joints.',
        detected_issues:['Stabilizing pose'], issue_codes:[],
        joint_angles:this._jointAngles(landmarks), confidence_score:0,
        personalized_correction:'Keep the entire body visible and avoid moving the camera.',
        session_state:'starting', exercise_key:key,
        landmarks:landmarks.map(p=>({x:p.x,y:p.y,z:p.z||0,visibility:p.visibility??0})),
        rep_just_counted:false
      };
    }

    const a=this._jointAngles(landmarks);
    const counted=this._count(key,landmarks,a);
    const confidence=this._confidenceScore(landmarks,a,key);
    const ready=confidence>=0.62;
    const {issues,corrections}=ready?this._issues(key,landmarks,a):{issues:[],corrections:[]};
    const accuracy=ready?Math.round(Math.max(0,Math.min(100,100-issues.length*14-(1-confidence)*16))):0;

    return {
      rep_count:this.repCount,
      posture_status:!ready?'No exercise detected':issues.length?'Incorrect posture':'Correct posture',
      accuracy,
      feedback:!ready?'Tracking confidence is low — keep the required joints visible.':(issues.join(' ')||'Good form. Keep the movement smooth and controlled.'),
      detected_issues:!ready?['Low pose confidence']:(issues.length?issues:['None — nice work']),
      issue_codes:issues.map(x=>x.toLowerCase().replace(/[^a-z0-9]+/g,'_')),
      joint_angles:a,
      confidence_score:Math.round(confidence*100)/100,
      personalized_correction:corrections[0]||'Maintain your alignment and complete the full movement range.',
      session_state:this._sessionState,
      exercise_key:key,
      landmarks:landmarks.map(p=>({x:p.x,y:p.y,z:p.z||0,visibility:p.visibility??0})),
      rep_just_counted:counted,
    };
  }
}

export function detectForVideo(video, timestampMs) {
  if (!landmarkerInstance) return null;
  const result = landmarkerInstance.detectForVideo(video, timestampMs);
  if (result?.landmarks?.length) {
    // Smooth in place: everything downstream (drawing, joint angles, rep
    // counting) reads result.landmarks, so one smoothing pass here removes
    // jitter for the whole pipeline instead of patching each consumer.
    result.landmarks[0] = smoother.smooth(result.landmarks[0], timestampMs);
  }
  return result;
}

export function closePoseLandmarker() {
  if (landmarkerInstance) {
    landmarkerInstance.close();
    landmarkerInstance = null;
    activeModelUrl = null;
    smoother.reset();
  }
}
