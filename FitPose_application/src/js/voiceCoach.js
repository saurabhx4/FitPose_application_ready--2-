// ===== Live voice coaching =====
// Turns each frame's pose-analysis result into short, natural-sounding speech.
// All live coaching phrases come from voicePhrases.js so the visible Voice
// Assistant text and the spoken Web Speech API output always use the user's
// currently selected FitPose language.
import { speak } from './voice.js';
import { getLanguage } from './i18n/i18n.js';
import { getPhrases } from './voicePhrases.js';

function currentPhrases() {
  return getPhrases(getLanguage());
}

function tableFor(map, exerciseKey) {
  return map[exerciseKey] || map.default;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let lastGoodSpokenAt = 0;
let lastRepAnnounced = 0;

/** Call once, right when a live session starts (before/while the camera opens). */
export function announceSessionStart(exerciseKey) {
  const phrases = currentPhrases();
  const text = tableFor(phrases.start, exerciseKey);
  speak(text, { key: 'start', force: true, cooldownMs: 0 });
  lastGoodSpokenAt = 0;
  lastRepAnnounced = 0;
  return text;
}

/** Call once when the person ends the session, with a short results summary. */
export function announceSessionEnd({ reps, avgForm }) {
  const phrases = currentPhrases();
  const text =
    reps > 0
      ? phrases.sessionEndWithReps(reps, avgForm)
      : phrases.sessionEndNoReps;
  speak(text, { key: 'end', force: true, cooldownMs: 0 });
  return text;
}

/**
 * Call on every analysis tick from the detection loop. Internally throttled
 * (via voice.js's cooldown + "don't talk over itself" logic) so this is safe
 * to call every animation frame.
 */
export function speakAnalysis(analysis) {
  if (!analysis) return null;
  const exerciseKey = analysis.exercise_key || 'default';
  const phrases = currentPhrases();
  let message = null;
  let options = null;

  if (analysis.accuracy <= 0) {
    message = phrases.noPerson;
    speak(message, { key: 'no-person', cooldownMs: 6000 });
    return message;
  }

  if (analysis.rep_just_counted && analysis.rep_count > 0) {
    message = phrases.rep(analysis.rep_count);
    speak(message, { key: `rep-${analysis.rep_count}`, cooldownMs: 0, force: true });
    return message;
  }

  const codes = analysis.issue_codes || [];
  if (codes.length) {
    const table = tableFor(phrases.corrections, exerciseKey);
    options = codes.map((c) => table[c]).filter(Boolean).slice(0, 2);
    if (options.length) {
      message = options.join(' ');
      speak(message, { key: codes.slice(0, 2).join('+'), cooldownMs: 5000 });
      return message;
    }
  }

  const now = Date.now();
  if (now - lastGoodSpokenAt > 8000) {
    lastGoodSpokenAt = now;
    message = pick(tableFor(phrases.goodForm, exerciseKey));
    speak(message, { key: 'good', cooldownMs: 8000 });
    return message;
  }
  return null;
}
