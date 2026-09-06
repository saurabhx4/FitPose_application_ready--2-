// ===== FitPose i18n =====
// FitPose's web app text is English-only — there is no page-text
// translation layer. The "language" tracked here only selects which
// language the on-device Voice Assistant speaks (voiceCoach.js /
// voicePhrases.js) and which language the AI Coach chat replies + speaks in
// (backend/ai_coach.py + backend/voice.py). `t()` below always resolves to
// the English strings in ./locales/en.json regardless of the selected
// voice language, so on-screen copy never changes.
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, isSupportedLanguage } from './languages.js';

import en from './locales/en.json';

const LANGUAGE_CHANGE_EVENT = 'fitpose:languagechange';

let currentLanguage = DEFAULT_LANGUAGE;

export function getLanguage() {
  return currentLanguage;
}

// Always resolves against the English bundle — the UI has only one language.
export function t(key) {
  if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
  return key.split('.').pop();
}

// Populates every [data-i18n]/[data-i18n-placeholder]/[data-i18n-title]
// element with its (always-English) string. Kept as a function — rather than
// inlined once at startup — because the app calls it again after inserting
// new DOM (e.g. the exercise preview modal) so those nodes get their text
// filled in too.
export function applyTranslations(root = document) {
  if (!document.body) return;

  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });

  document.documentElement.setAttribute('lang', 'en');
  document.documentElement.setAttribute('dir', 'ltr');
}

// Sets the Voice Assistant / AI Coach spoken language. Does NOT retranslate
// any on-screen text (there is nothing to retranslate).
export function setLanguage(code) {
  currentLanguage = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
  window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGE_EVENT, { detail: { code: currentLanguage } }));
  return currentLanguage;
}

export function onLanguageChange(handler) {
  window.addEventListener(LANGUAGE_CHANGE_EVENT, (e) => handler(e.detail.code));
}

export { SUPPORTED_LANGUAGES };
