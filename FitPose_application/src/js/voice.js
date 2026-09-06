// ===== On-device voice engine (Web Speech API) =====
// Everything here runs locally in the browser via `speechSynthesis` — no
// audio is recorded or sent anywhere, matching the rest of FitPose's
// on-device/nothing-uploaded approach to the camera feed.
const synth = window.speechSynthesis || null;

const PREF_KEY = 'fitpose_voice_enabled_v1';
let enabled = readPref();
let preferredVoice = null;
// BCP-47 tag for the currently selected FitPose language (see
// src/js/i18n/languages.js voiceLang) — defaults to English until app.js
// calls setVoiceLanguage() during startup/language change.
let voiceLangTag = 'en-US';

function readPref() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    return raw === null ? true : JSON.parse(raw); // on by default
  } catch {
    return true;
  }
}

function pickVoice() {
  if (!synth) return;
  const voices = synth.getVoices();
  if (!voices.length) return;
  const langPrefix = voiceLangTag.split('-')[0];
  preferredVoice =
    // Exact locale match for the selected language (e.g. hi-IN).
    voices.find((v) => v.lang?.toLowerCase() === voiceLangTag.toLowerCase()) ||
    // Any voice for that language, regardless of region.
    voices.find((v) => new RegExp(`^${langPrefix}`, 'i').test(v.lang || '')) ||
    // Fall back to the original English heuristic — many browsers ship no
    // voice at all for some of FitPose's supported languages, so spoken
    // coaching simply continues in English rather than failing.
    voices.find((v) => /en-US/i.test(v.lang) && /female|Samantha|Google US English|Zira/i.test(v.name)) ||
    voices.find((v) => /^en/i.test(v.lang || '')) ||
    voices[0];
}
if (synth) {
  pickVoice();
  synth.onvoiceschanged = pickVoice;
}

// Called by app.js on startup and whenever the Profile → Preferred Language
// selection changes. Only affects which voice speaks (text-to-speech); this
// app has no speech-to-text/microphone input to redirect.
export function setVoiceLanguage(bcp47Tag) {
  voiceLangTag = bcp47Tag || 'en-US';
  pickVoice();
}

export function isVoiceSupported() {
  return !!synth;
}

export function isVoiceEnabled() {
  return enabled && !!synth;
}

export function setVoiceEnabled(value) {
  enabled = !!value;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(enabled));
  } catch {
    /* ignore quota errors */
  }
  if (!enabled) synth?.cancel();
}

export function toggleVoiceEnabled() {
  setVoiceEnabled(!enabled);
  return enabled;
}

let lastKey = null;
let lastSpokenAt = 0;

/**
 * Speak a short phrase.
 * - `key`: a dedupe/cooldown identifier (e.g. an issue code) — the same key
 *   won't be repeated within `cooldownMs`, so live per-frame analysis doesn't
 *   turn into a wall of repeated speech.
 * - `force`: interrupts whatever is currently being said (used for session
 *   start/end announcements, which should always be heard in full).
 */
export function speak(text, { key = null, cooldownMs = 4500, force = false } = {}) {
  if (!synth || !enabled || !text) return false;
  const now = Date.now();
  if (!force) {
    if (synth.speaking) return false; // never talk over itself
    if (key && key === lastKey && now - lastSpokenAt < cooldownMs) return false;
  } else {
    synth.cancel();
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = preferredVoice?.lang || voiceLangTag;
  if (preferredVoice) utter.voice = preferredVoice;
  utter.rate = 1.03;
  utter.pitch = 1;
  utter.volume = 1;
  synth.speak(utter);
  lastKey = key;
  lastSpokenAt = now;
  return true;
}

export function stopSpeaking() {
  synth?.cancel();
}
