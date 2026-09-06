// ===== Central language configuration =====
// FitPose's web app UI is English-only. This list only controls the
// language the on-device "Voice Assistant" (voiceCoach.js / voicePhrases.js)
// speaks during a live session, and the language the AI Coach chat replies
// and speaks in (backend/ai_coach.py + backend/voice.py). Nothing here
// changes any on-screen text.
//
// code        - ISO 639-1 code, persisted as the user's preferred_language
//               value.
// name        - English display name.
// nativeName  - Name written in the language's own script (shown in the
//               language picker).
// voiceLang   - BCP-47 tag used to pick a matching Web Speech API voice for
//               spoken (voice assistant) output. Speech-to-text for the AI
//               Coach's mic input is handled server-side (OpenAI Whisper),
//               which auto-detects language, so this tag is only used to
//               select a text-to-speech voice in the browser.
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', voiceLang: 'en-US' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', voiceLang: 'hi-IN' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', voiceLang: 'de-DE' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', voiceLang: 'ru-RU' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', voiceLang: 'bn-IN' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', voiceLang: 'ta-IN' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', voiceLang: 'te-IN' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', voiceLang: 'mr-IN' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', voiceLang: 'gu-IN' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', voiceLang: 'kn-IN' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', voiceLang: 'ml-IN' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', voiceLang: 'pa-IN' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', voiceLang: 'ur-PK' },
];

export const DEFAULT_LANGUAGE = 'en';

const BY_CODE = Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.code, l]));

export function isSupportedLanguage(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(BY_CODE, code);
}

export function getLanguageMeta(code) {
  return BY_CODE[code] || BY_CODE[DEFAULT_LANGUAGE];
}
