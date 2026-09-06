import { Auth, Store, todayISO } from './store.js';
import { EXERCISES, findExercise } from './exercises.js';
import { toast } from './toast.js';
import { coachReply, getAICoachReply, isAICoachConfigured } from './coach.js';
import { loadPoseLandmarker, detectForVideo, ExerciseAnalyzer, POSE_CONNECTIONS } from './pose.js';
import { isVoiceEnabled, isVoiceSupported, toggleVoiceEnabled, stopSpeaking, setVoiceLanguage } from './voice.js';
import { announceSessionStart, announceSessionEnd, speakAnalysis } from './voiceCoach.js';
import { openPreview, closePreview, activePreviewExercise } from './exercisePreview.js';
import { t, setLanguage, getLanguage, applyTranslations, onLanguageChange, SUPPORTED_LANGUAGES } from './i18n/i18n.js';
import { getLanguageMeta } from './i18n/languages.js';
import { isPremium, activateDemoPremium, cancelSubscription, requirePremium, PREMIUM_FEATURES } from './subscription.js';
import { listChats, createChat, saveChat, getChat, deleteChat, renameChat } from './chatHistory.js';
import {
  isVoiceInputConfigured, isMicSupported, isRecording,
  startRecording, stopRecording, cancelRecording,
  transcribeAudio, speakText, MicPermissionError, NoSpeechError,
} from './voiceInput.js';

// ===================== LANGUAGE (Voice Assistant only) =====================
// FitPose's screens are always in English — there is no page-text
// translation. This selector only controls which language the on-device
// Voice Assistant (voiceCoach.js) and the AI Coach chat speak. Populate it
// from the single central SUPPORTED_LANGUAGES config (src/js/i18n/languages.js)
// — add a language there + a phrase table in voicePhrases.js and it shows
// up here automatically.
const languageSelect = document.getElementById('languageSelect');
if (languageSelect) {
  languageSelect.innerHTML = SUPPORTED_LANGUAGES
    .map((l) => `<option value="${l.code}">${l.nativeName} — ${l.name}</option>`)
    .join('');
}
const signupLanguage = document.getElementById('signupLanguage');
const onboardingLanguage = document.getElementById('onboardingLanguage');
function populateLanguageSelect(select) {
  if (!select) return;
  select.innerHTML = SUPPORTED_LANGUAGES.map((l) => `<option value="${l.code}">${l.nativeName} — ${l.name}</option>`).join('');
}
populateLanguageSelect(signupLanguage);
populateLanguageSelect(onboardingLanguage);

// ----- Quick-access language icon + popover (Profile header) -----
// A faster path to the same preference as the "Preferred Language" select
// below in Account & sign-in — same SUPPORTED_LANGUAGES source, same
// setPreferredLanguage() call, so both stay in sync automatically.
const langIconBtn = document.getElementById('langIconBtn');
const langPopover = document.getElementById('langPopover');
if (langPopover) {
  langPopover.innerHTML = SUPPORTED_LANGUAGES
    .map((l) => `<button type="button" class="langOption" data-code="${l.code}" role="menuitemradio">
      <span><span class="langNative">${l.nativeName}</span><span class="langName">${l.name}</span></span>
      <span class="langCheck">✓</span>
    </button>`)
    .join('');
}
function markActiveLangOption(code) {
  if (!langPopover) return;
  langPopover.querySelectorAll('.langOption').forEach((el) => {
    el.classList.toggle('active', el.dataset.code === code);
  });
}
function closeLangPopover() {
  if (!langPopover || !langIconBtn) return;
  langPopover.hidden = true;
  langIconBtn.setAttribute('aria-expanded', 'false');
}
function toggleLangPopover() {
  if (!langPopover || !langIconBtn) return;
  const willOpen = langPopover.hidden;
  langPopover.hidden = !willOpen;
  langIconBtn.setAttribute('aria-expanded', String(willOpen));
}
if (langIconBtn) {
  langIconBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleLangPopover();
  });
}
if (langPopover) {
  langPopover.addEventListener('click', (e) => {
    const opt = e.target.closest('.langOption');
    if (!opt) return;
    window.setPreferredLanguage(opt.dataset.code);
    closeLangPopover();
  });
}
document.addEventListener('click', (e) => {
  if (langPopover && !langPopover.hidden && !langPopover.contains(e.target) && e.target !== langIconBtn) {
    closeLangPopover();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLangPopover();
});

window.setPreferredLanguage = (code) => {
  const applied = Store.setPreferredLanguage(code);
  setLanguage(applied);
  if (languageSelect) languageSelect.value = applied;
  if (signupLanguage) signupLanguage.value = applied;
  if (onboardingLanguage) onboardingLanguage.value = applied;
  markActiveLangOption(applied);
  refreshNavLabels();
  renderPremium();
  renderChatHistory();
  if (document.getElementById('profile').classList.contains('active')) renderProfile();
};
onLanguageChange((code) => {
  // The only effect of a language change: pick a matching browser voice for
  // the Voice Assistant (live coaching) and the AI Coach's spoken replies.
  // On-screen text never changes, so no page re-render is needed here.
  setVoiceLanguage(getLanguageMeta(code).voiceLang);
});
document.getElementById('saveProfileDetails')?.addEventListener('click', () => {
  Store.setProfileDetails({
    ageGroup: document.getElementById('profileAgeGroup')?.value || '',
    gender: document.getElementById('profileGender')?.value || ''
  });
  toast(t('onboarding.saved'), 'ok');
});
// Initialize from whatever was saved (per-account, or the guest fallback)
// before anything renders, so the very first paint is already correct.
setLanguage(Store.getPreferredLanguage());
if (languageSelect) languageSelect.value = getLanguage();
markActiveLangOption(getLanguage());
setVoiceLanguage(getLanguageMeta(getLanguage()).voiceLang);

// ===================== NAVIGATION =====================
// `pages` is every routable page (used by show() for toggling/gating).
// `NAV_PAGES` is only what gets its own top-nav link — 'login' and 'profile'
// are deliberately excluded because the nav shows a single sign-in-or-name
// element for both (see refreshAuthUI): "Sign in" when signed out, or the
// user's own name (which opens their profile) when signed in.
const pages = ['home', 'dashboard', 'exercises', 'workout', 'ai', 'schedule', 'about', 'research', 'references', 'faq', 'premium', 'profile', 'login'];
const NAV_PAGES = ['home', 'dashboard', 'exercises', 'workout', 'ai', 'schedule', 'about', 'faq'];
const navKeys = { home: 'nav.home', dashboard: 'nav.dashboard', exercises: 'nav.exercises', workout: 'nav.workout', ai: 'nav.ai', schedule: 'nav.schedule', about: 'nav.about', faq: 'nav.faq', profile: 'nav.profile', login: 'nav.login' };
const icons = { home: '⌂', dashboard: '◫', exercises: '◈', workout: '✦', ai: '✦', schedule: '▤', about: 'ℹ', faq: '❔', profile: '◉' };

function labels(id) {
  return t(navKeys[id]);
}

function refreshNavLabels() {
  applyTranslations();
  document.getElementById('navlinks').innerHTML = NAV_PAGES
    .map((p) => `<button data-page="${p}" onclick="show('${p}')">${labels(p)}</button>`)
    .join('');
  document.getElementById('mobileNav').innerHTML = ['home', 'exercises', 'workout', 'ai', 'dashboard']
    .map((p) => `<button data-page="${p}" onclick="show('${p}')"><b style="font-size:18px">${icons[p]}</b><br>${labels(p)}</button>`)
    .join('');
  const active = pages.find((p) => document.getElementById(p).classList.contains('active'));
  document.querySelectorAll('.navlinks button,.mobileNav button').forEach((b) => b.classList.toggle('active', b.dataset.page === active));
  refreshAuthUI();
}

const GATED_PAGES = new Set(['dashboard', 'profile']);

function show(id) {
  if (id === 'progress') id = 'dashboard'; // Progress was folded into Dashboard — keep old links/bookmarks working
  if (GATED_PAGES.has(id) && !Auth.isLoggedIn()) {
    toast('Sign in to view that page', 'err');
    id = 'login';
  }
  pages.forEach((p) => document.getElementById(p).classList.toggle('active', p === id));
  document.querySelectorAll('.navlinks button,.mobileNav button').forEach((b) => b.classList.toggle('active', b.dataset.page === id));
  history.replaceState(null, '', '#' + id);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id !== 'workout') stopSession();
  if (id !== 'ai') cancelAssistantVoiceIfActive();
  if (id === 'dashboard') renderDashboard();
  if (id === 'profile') renderProfile();
  if (id === 'exercises') renderLibrary('All');
  if (id === 'ai') { renderPlanStatus(); renderConversation(); renderChatHistory(); }
  if (id === 'home') renderHome();
  if (id === 'schedule') renderSchedule();
  if (id === 'research') renderResearch();
  if (id === 'references') renderReferences();
  if (id === 'premium') renderPremium();
}
window.show = show;

refreshNavLabels();

// ===================== THEME =====================
// Four modes now: light (default) → dark (pure black glass) → vibrant (the
// premium zip's light purple/pink/blue look) → aurora (the premium zip's own
// dark mode) → back to light. Each click on the theme button advances one
// step; the chosen mode is remembered per browser.
const THEME_ORDER = ['light', 'dark', 'vibrant', 'aurora'];
const THEME_ICON = { light: '☼', dark: '☾', vibrant: '✦', aurora: '✶' };
const THEME_TITLE = { light: 'Switch to dark mode', dark: 'Switch to vibrant mode', vibrant: 'Switch to aurora mode', aurora: 'Switch to light mode' };
function applyTheme(mode) {
  const theme = THEME_ORDER.includes(mode) ? mode : 'light';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('fitpose-theme', theme);
  const btn = document.getElementById('theme');
  btn.textContent = THEME_ICON[theme];
  btn.title = THEME_TITLE[theme];
}
applyTheme(localStorage.getItem('fitpose-theme') || 'light');
document.getElementById('theme').onclick = () => {
  const current = document.documentElement.dataset.theme;
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  applyTheme(next);
};

// ===================== VOICE COACH TOGGLE =====================
function refreshVoiceBtn() {
  const btn = document.getElementById('voiceToggleBtn');
  if (!btn) return;
  if (!isVoiceSupported()) {
    btn.textContent = '🔇';
    btn.title = 'Voice guidance is not supported in this browser';
    btn.disabled = true;
    return;
  }
  const on = isVoiceEnabled();
  btn.textContent = on ? '🔊' : '🔇';
  btn.title = on ? 'Voice coaching on — click to mute' : 'Voice coaching muted — click to enable';
}
document.getElementById('voiceToggleBtn')?.addEventListener('click', () => {
  toggleVoiceEnabled();
  refreshVoiceBtn();
});
refreshVoiceBtn();

// ===================== AUTH UI =====================
function refreshAuthUI() {
  const loggedIn = Auth.isLoggedIn();
  const navActions = document.getElementById('navActions');
  const existingChip = document.getElementById('userChipBtn');
  if (existingChip) existingChip.remove();
  const loginBtn = document.getElementById('navLoginBtn');
  if (loggedIn) {
    const user = Auth.currentUser();
    loginBtn.style.display = 'none';
    const chip = document.createElement('button');
    chip.id = 'userChipBtn';
    chip.onclick = () => show('profile');
    const premium = isPremium();
    chip.className = `userchip ${premium ? 'premiumChip' : ''}`;
    chip.innerHTML = premium ? `<span class="premiumCrown">✦</span><span>PREMIUM</span>` : `<span class="av">${(user?.name || '?').slice(0, 1).toUpperCase()}</span><span>${user?.name || 'You'}</span>`;
    navActions.insertBefore(chip, loginBtn);
  } else {
    loginBtn.style.display = '';
  }
}

window.togglePass = (btn) => {
  const input = btn.previousElementSibling;
  input.type = input.type === 'password' ? 'text' : 'password';
};

function showSignin() {
  document.getElementById('signinCard').style.display = '';
  document.getElementById('signupCard').style.display = 'none';
  document.getElementById('forgotCard').style.display = 'none';
}
function showSignup() {
  document.getElementById('signinCard').style.display = 'none';
  document.getElementById('signupCard').style.display = '';
  document.getElementById('forgotCard').style.display = 'none';
}
function openForgot() {
  document.getElementById('signinCard').style.display = 'none';
  document.getElementById('signupCard').style.display = 'none';
  document.getElementById('forgotCard').style.display = '';
}
window.showSignin = showSignin;
window.showSignup = showSignup;
window.openForgot = openForgot;

document.getElementById('signinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('signinEmail').value.trim();
  const password = document.getElementById('signinPassword').value;
  const err = document.getElementById('signinErr');
  err.textContent = '';
  if (!email || !password) { err.textContent = 'Please fill in both fields.'; return; }
  try {
    const btn = document.getElementById('signinSubmit');
    btn.disabled = true; btn.textContent = 'Signing in…';
    await Auth.login(email, password);
    afterLogin();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    const btn = document.getElementById('signinSubmit');
    btn.disabled = false; btn.textContent = 'Sign in →';
  }
});

document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const ageGroup = document.getElementById('signupAgeGroup').value;
  const gender = document.getElementById('signupGender').value;
  const preferredLanguage = document.getElementById('signupLanguage').value;
  const err = document.getElementById('signupErr');
  err.textContent = '';
  if (!name || !email || !password || !ageGroup || !gender || !preferredLanguage) { err.textContent = 'Please complete all profile fields.'; return; }
  if (password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
  try {
    const btn = document.getElementById('signupSubmit');
    btn.disabled = true; btn.textContent = 'Creating account…';
    await Auth.signup(name, email, password);
    Store.setProfileDetails({ ageGroup, gender, preferredLanguage });
    setLanguage(preferredLanguage);
    toast('Welcome to FitPose! 🎉', 'ok');
    afterLogin();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    const btn = document.getElementById('signupSubmit');
    btn.disabled = false; btn.textContent = 'Create account →';
  }
});

document.getElementById('googleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('googleBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Connecting to Google…';
  try {
    const user = await Auth.loginWithGoogle();
    toast(`Signed in as ${user.name} via Google`, 'ok');
    afterLogin();
  } catch (ex) {
    toast(ex.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('appPasswordForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('newAppPassword').value;
  const err = document.getElementById('appPasswordErr');
  err.textContent = '';
  try {
    const btn = document.getElementById('appPasswordSubmit');
    btn.disabled = true; btn.textContent = 'Saving…';
    await Auth.setAppPassword(pw);
    document.getElementById('newAppPassword').value = '';
    toast('Password saved — you can sign in with email + password too now.', 'ok');
    renderProfile();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    const btn = document.getElementById('appPasswordSubmit');
    btn.disabled = false; btn.textContent = 'Save password →';
  }
});

window.doReset = async () => {
  const email = document.getElementById('forgotEmail').value.trim();
  const err = document.getElementById('forgotErr');
  err.textContent = '';
  if (!email) { err.textContent = 'Enter your account email.'; return; }
  try {
    const temp = await Auth.resetPassword(email);
    toast(`Temporary password: ${temp} (demo — use it to sign in)`, 'ok');
    showSignin();
    document.getElementById('signinEmail').value = email;
  } catch (ex) {
    err.textContent = ex.message;
  }
};

function afterLogin() {
  refreshAuthUI();
  // Switch to this account's own saved language (falls back to English if
  // this is a brand-new account) rather than leaving the guest's choice in
  // place — matches "preferred language follows the user's profile".
  setLanguage(Store.getPreferredLanguage());
  refreshNavLabels();
  document.getElementById('signinForm').reset();
  document.getElementById('signupForm')?.reset();
  showSignin();
  toast(`Welcome back, ${Auth.currentUser()?.name || ''}!`, 'ok');
  activeChatId = null;
  renderChatHistory();
  renderConversation();
  renderPremium();
  const details = Store.getProfileDetails();
  const needsOnboarding = !details.ageGroup || !details.gender || !details.preferredLanguage;
  if (needsOnboarding) {
    openProfileOnboarding();
  } else {
    show('dashboard');
  }
}

function openProfileOnboarding() {
  const modal = document.getElementById('profileOnboardingModal');
  if (!modal) return;
  const d = Store.getProfileDetails();
  document.getElementById('onboardingAgeGroup').value = d.ageGroup || '';
  document.getElementById('onboardingGender').value = d.gender || '';
  document.getElementById('onboardingLanguage').value = d.preferredLanguage || getLanguage();
  modal.hidden = false;
  applyTranslations(modal);
}
function closeProfileOnboarding() {
  const modal = document.getElementById('profileOnboardingModal');
  if (modal) modal.hidden = true;
}
document.getElementById('saveOnboarding')?.addEventListener('click', () => {
  const ageGroup = document.getElementById('onboardingAgeGroup').value;
  const gender = document.getElementById('onboardingGender').value;
  const preferredLanguage = document.getElementById('onboardingLanguage').value;
  const err = document.getElementById('onboardingErr');
  if (!ageGroup || !gender || !preferredLanguage) { err.textContent = t('onboarding.required'); return; }
  Store.setProfileDetails({ ageGroup, gender, preferredLanguage });
  setLanguage(preferredLanguage);
  closeProfileOnboarding();
  refreshNavLabels();
  renderProfile();
  show('dashboard');
  toast(t('onboarding.saved'), 'ok');
});

window.doSignOut = () => {
  Auth.logout();
  refreshAuthUI();
  setLanguage(Store.getPreferredLanguage());
  refreshNavLabels();
  activeChatId = null;
  renderChatHistory();
  renderConversation();
  renderPremium();
  toast('Signed out');
  show('home');
};

// ===================== HOME =====================
// Store.get()/derived stats already resolve to a true zero state whenever
// nobody is signed in (see defaultUserData in store.js), so this always
// reflects reality: zeros for a signed-out visitor, real numbers — updated
// live as sessions are recorded — once someone signs in.
function renderHome() {
  const loggedIn = Auth.isLoggedIn();
  const avgForm = Store.overallAvgForm();
  const streak = Store.get().stats.streak;
  document.getElementById('homeFormScore').textContent = avgForm + '%';
  document.getElementById('homeStreak').textContent = streak + ' 🔥';
  document.getElementById('homeMovementScore').textContent = avgForm + '%';
  document.getElementById('homeMovementBar').style.setProperty('--w', avgForm + '%');
  document.getElementById('homeWorkoutTime').textContent = Store.todayMinutes() + 'm';
  document.getElementById('homeCalories').textContent = Store.todayCalories();
  document.getElementById('homeStreakNum').textContent = streak + ' 🔥';
  document.getElementById('liveDataChip').textContent = loggedIn ? 'Your live data' : 'Sign in to see your data';
}

// ===================== SCHEDULE =====================
// The Schedule page now shows a single "Your schedule" card (the ordered
// queue of exercises the user has built, plus their preferred time) rather
// than a fixed Mon-Sun grid. Building/editing happens in the Schedule
// Builder modal below — either by hand ("Add exercise") or in one shot via
// "Generate with AI Coach" (Premium only; see aiGenerateSchedule()).
function renderSchedule() {
  const card = document.getElementById('yourScheduleCard');
  const actionBtn = document.getElementById('scheduleActionBtn');
  if (!card) return;
  const schedule = Store.getSchedule();
  const hasSchedule = Store.hasSchedule();

  if (actionBtn) actionBtn.textContent = hasSchedule ? '✦ Edit schedule' : '✦ Create a schedule';

  if (!hasSchedule) {
    card.innerHTML = `<h3>Your schedule</h3><div class="scheduleEmptyState">You haven't built a schedule yet. Add exercises to a queue, pick a time that works for you, and FitPose will keep it ready — or let the AI Coach put one together for you.</div>`;
    return;
  }

  const totalMin = Store.scheduleTotalMinutes();
  const items = schedule.exercises.map((id, i) => {
    const ex = findExercise(id);
    return `<div class="scheduleListItem"><span class="schedNum">${i + 1}</span><div><b>${ex ? `${ex.emoji || ''} ${ex.name}` : 'Unknown exercise'}</b><br><span class="muted">${ex ? `${ex.desc} · ${ex.duration}m` : ''}</span></div></div>`;
  }).join('') || '<div class="scheduleEmptyState">No exercises in this schedule yet.</div>';

  card.innerHTML = `<h3>Your schedule</h3>
    <div class="scheduleMetaRow">
      <span>⏰ Time: <b>${schedule.time || 'Not set'}</b></span>
      <span>Total: <b>${totalMin}m</b></span>
      <span>${schedule.createdBy === 'ai' ? '✦ AI-generated' : 'Built by you'}${schedule.condition ? ` · ${schedule.condition}` : ''}</span>
    </div>
    <div class="scheduleList">${items}</div>`;
}

// ----- Schedule Builder modal (manual add/remove + time + AI generate) -----
function populateScheduleExerciseSelect() {
  const select = document.getElementById('scheduleExerciseSelect');
  if (!select) return;
  select.innerHTML = EXERCISES.map((e) => `<option value="${e.id}">${e.emoji || ''} ${e.name} (${e.duration}m)</option>`).join('');
}
function renderScheduleQueue() {
  const list = document.getElementById('scheduleQueueList');
  const totalEl = document.getElementById('scheduleTotalTimeVal');
  const timeInput = document.getElementById('scheduleTimeInput');
  if (!list) return;
  const schedule = Store.getSchedule();
  const exercises = schedule?.exercises || [];
  if (timeInput) timeInput.value = schedule?.time || '';
  if (totalEl) totalEl.textContent = `${Store.scheduleTotalMinutes()}m`;
  list.innerHTML = exercises.length
    ? exercises.map((id, i) => {
        const ex = findExercise(id);
        return `<div class="scheduleQueueItem"><div><b>${ex ? `${ex.emoji || ''} ${ex.name}` : 'Unknown'}</b><br><span class="muted">${ex ? `${ex.duration}m · ${ex.desc}` : ''}</span></div><button class="scheduleQueueRemove" onclick="removeScheduleExercise(${i})" aria-label="Remove">✕</button></div>`;
      }).join('')
    : '<div class="scheduleQueueEmpty">Your queue is empty — add exercises above.</div>';
}
window.openScheduleBuilder = () => {
  populateScheduleExerciseSelect();
  renderScheduleQueue();
  document.getElementById('scheduleBuilderModal')?.classList.add('open');
};
window.closeScheduleBuilder = () => {
  document.getElementById('scheduleBuilderModal')?.classList.remove('open');
  renderSchedule();
};
window.addScheduleExercise = () => {
  const select = document.getElementById('scheduleExerciseSelect');
  if (!select?.value) return;
  Store.addScheduleExercise(select.value);
  renderScheduleQueue();
};
window.removeScheduleExercise = (index) => {
  Store.removeScheduleExercise(index);
  renderScheduleQueue();
};
window.onScheduleTimeChange = (value) => {
  Store.setScheduleTime(value);
  renderScheduleQueue();
};
window.clearScheduleBuilder = () => {
  Store.clearSchedule();
  renderScheduleQueue();
  toast('Schedule cleared', 'ok');
};
window.saveScheduleBuilder = () => {
  if (!Store.hasSchedule()) { toast('Add at least one exercise first', 'err'); return; }
  toast('Schedule saved ✦', 'ok');
  window.closeScheduleBuilder();
};

// Ask the AI Coach to build a whole schedule in one go: what they want to
// work on, how many days a week, and a favourable time of day — then
// (Premium only) turns that straight into a saved schedule. Reuses the
// same /api/coach backend as the AI chat page (backend/ai_coach.py), just
// with a purpose-built message instead of free-form chat.
window.aiGenerateSchedule = async () => {
  if (!requirePremium(PREMIUM_FEATURES.aiSchedule)) return;
  if (!isAICoachConfigured()) {
    toast('FitPose AI is not configured on this server, so schedules can only be built manually right now.', 'err');
    return;
  }
  const goal = prompt("What would you like this schedule to help with? (e.g. a problem like back pain, or a goal like general fitness)");
  if (!goal) return;
  const days = Math.min(7, Math.max(1, Number(prompt('How many days a week can you work out?', '5')) || 5));
  const time = prompt('What time of day works best for you? (e.g. 7:00 AM, evening)', '7:00 AM');
  if (!time) return;

  toast('Asking FitPose AI Coach to build your schedule…', 'ok');
  try {
    const ai = await getAICoachReply([
      { role: 'user', content: `Please build me a workout schedule. What I want it to help with: ${goal}. Days per week I can work out: ${days}. My favourable time of day to work out: ${time}.` },
    ]);
    const schedule = ai?.schedule;
    if (schedule?.exerciseIds?.length) {
      Store.setSchedule({ exercises: schedule.exerciseIds, time: schedule.time || time, createdBy: 'ai', condition: schedule.goal || goal });
      renderScheduleQueue();
      renderSchedule();
      toast('Your AI-generated schedule is ready ✦', 'ok');
    } else {
      toast(ai?.reply || "FitPose AI couldn't finalize a schedule from that — try adding exercises manually below.", 'err');
    }
  } catch {
    toast("Couldn't reach FitPose AI — add exercises manually below instead.", 'err');
  }
};

// ===================== CALENDAR =====================
function buildCalendar(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const data = Store.get();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = todayISO();
  for (let i = 1; i <= 35; i++) {
    const d = document.createElement('div');
    d.className = 'day';
    if (i <= daysInMonth) {
      d.textContent = i;
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      const minutes = data.calendarDays[dateStr];
      if (minutes) d.classList.add('done');
      if (minutes >= 25) d.classList.add('hot');
      if (dateStr === todayStr) d.classList.add('today');
    }
    el.appendChild(d);
  }
}

// ===================== METRIC TABS (dashboard + progress) =====================
window.metric = (btn, type, scope) => {
  btn.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active');
  const title = document.getElementById(`metricTitle-${scope}`);
  const text = document.getElementById(`metricText-${scope}`);
  const bars = document.getElementById(`bars-${scope}`);
  if (!title) return;
  let heights, label, sub;
  if (type === 'daily') {
    heights = Store.weeklyBars();
    label = 'Daily activity'; sub = "Today's movement minutes, last 7 days";
  } else if (type === 'weekly') {
    heights = Store.weeklyBars();
    label = 'Weekly consistency'; sub = 'Movement minutes across the week';
  } else {
    heights = Store.monthlyBars();
    label = 'Monthly momentum'; sub = 'Four weeks of consistency';
  }
  title.textContent = label;
  text.textContent = sub;
  bars.innerHTML = heights.map((h) => `<i class="bar" style="--h:${h}%"></i>`).join('');
};

// ===================== DASHBOARD (activity, attendance, streak, progress) =====================
function renderDashboard() {
  const user = Auth.currentUser();
  const data = Store.get();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('dashGreeting').textContent = `${greeting}, ${user?.name || 'there'} 👋`;

  // Today snapshot
  document.getElementById('dashForm').textContent = Store.overallAvgForm() + '%';
  document.getElementById('dashCalories').textContent = Store.todayCalories();
  document.getElementById('dashTime').textContent = Store.todayMinutes() + 'm';
  document.getElementById('dashStreak').textContent = data.stats.streak + ' 🔥';

  // Longer-range progress snapshot
  const score = Store.consistencyScore();
  document.getElementById('progWeek').textContent = Store.weekMinutes() + 'm';
  document.getElementById('progBest').textContent = (data.stats.bestStreak || data.stats.streak) + ' 🔥';
  document.getElementById('progSessions').textContent = Store.totalSessions();
  document.getElementById('progScoreNum').textContent = score + '%';

  // Attendance, streak card, consistency ring
  document.getElementById('dashStreakDays').textContent = data.stats.streak + ' days';
  document.getElementById('dashBestStreak').textContent = `Best: ${data.stats.bestStreak || data.stats.streak} days`;
  buildCalendar('calendar');
  document.getElementById('progRing').style.background = `conic-gradient(var(--accent) 0 ${score}%, color-mix(in srgb,var(--text) 8%,transparent) ${score}%)`;
  document.getElementById('progRingScore').textContent = score + '%';

  // Daily / weekly / monthly activity bars
  const activeBtn = document.querySelector('#dashTabs button.active') || document.querySelector('#dashTabs button');
  metric(activeBtn, 'daily', 'dash');

  // Recent sessions
  const list = document.getElementById('recentSessions');
  if (!data.sessions.length) {
    list.innerHTML = `<div class="card"><p class="muted">No sessions logged yet — start a live workout and it'll show up here.</p></div>`;
  } else {
    list.innerHTML = data.sessions
      .slice(0, 8)
      .map(
        (s) => `<div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <div><b>${s.exerciseLabel}</b><p class="muted" style="margin:4px 0 0">${new Date(s.time).toLocaleString()}</p></div>
          <div style="display:flex;gap:18px;text-align:center">
            <div><div class="num" style="font-size:20px">${s.reps}</div><span class="muted" style="font-size:11px">reps</span></div>
            <div><div class="num" style="font-size:20px">${s.avgForm}%</div><span class="muted" style="font-size:11px">form</span></div>
            <div><div class="num" style="font-size:20px">${Math.round(s.durationSec / 60)}m</div><span class="muted" style="font-size:11px">time</span></div>
          </div>
        </div>`
      )
      .join('');
  }
}

// ===================== PROFILE =====================
function renderProfile() {
  const profileDetails = Store.getProfileDetails();
  document.getElementById('profileAgeGroup')?.setAttribute('value', profileDetails.ageGroup);
  if (document.getElementById('profileAgeGroup')) document.getElementById('profileAgeGroup').value = profileDetails.ageGroup || '18-60';
  if (document.getElementById('profileGender')) document.getElementById('profileGender').value = profileDetails.gender || 'prefer_not';

  const user = Auth.currentUser();
  const data = Store.get();
  document.getElementById('profileName').textContent = user?.name || 'Guest';
  document.getElementById('profileEmail').textContent = user?.email || '';
  document.getElementById('profileStreakChip').textContent = `🔥 ${data.stats.streak} day streak`;
  document.getElementById('signoutBtn').style.display = '';
  if (languageSelect) languageSelect.value = Store.getPreferredLanguage();
  markActiveLangOption(Store.getPreferredLanguage());
  document.getElementById('goalsList').innerHTML = data.goals
    .map((g, i) => `<li><span>${g}</span><button class="smallbtn" onclick="removeGoal(${i})">Remove</button></li>`)
    .join('') || '<li class="muted">No goals yet — add one below.</li>';
  document.getElementById('achvList').innerHTML = Store.achievements()
    .map((a) => `<div class="${a.unlocked ? '' : 'locked'}">${a.icon} ${a.label}${a.unlocked ? '' : ' — locked'}</div>`)
    .join('');
  const googleStatus = document.getElementById('googleLinkStatus');
  if (googleStatus) googleStatus.textContent = user?.googleId ? `Linked as ${user.email}.` : 'Not linked — sign out and use "Continue with Google" to link this email.';
  const pwStatus = document.getElementById('appPasswordStatus');
  if (pwStatus) pwStatus.textContent = user?.passwordHash
    ? 'A password is set — you can sign in with email + password any time.'
    : 'No app password yet — set one so you can sign in without Google.';
}
window.addGoal = () => {
  const input = document.getElementById('goalInput');
  const val = input.value.trim();
  if (!val) return;
  Store.addGoal(val);
  input.value = '';
  renderProfile();
};
window.removeGoal = (i) => {
  Store.removeGoal(i);
  renderProfile();
};

// ===================== EXERCISE LIBRARY =====================
window.filterLib = (btn) => {
  document.querySelectorAll('#libTabs button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderLibrary(btn.dataset.cat);
};
function renderLibrary(cat) {
  const grid = document.getElementById('exerciseGrid');
  const items = cat === 'All' ? EXERCISES : EXERCISES.filter((e) => e.category === cat);
  if (!items.length) {
    grid.innerHTML = `<div class="emptylib">No exercises in this category yet.</div>`;
    return;
  }
  grid.innerHTML = items
    .map(
      (e) => `<div class="card exercise"><div class="exerciseArt"><img src="${e.thumb}" alt="${e.name}" loading="lazy" width="800" height="450"></div>
      <span class="chip">${e.code ? e.code + ' · ' : ''}${e.category} · ${e.difficulty}</span><h3>${e.name}</h3><p class="muted">${e.desc} · ${e.duration} min</p>
      <button class="btn primary" onclick="startExercise('${e.id}')">Start AI →</button>
      <button class="btn soft previewOpenBtn" onclick="openExercisePreview('${e.id}')">▶ Preview</button></div>`
    )
    .join('');
}
window.startExercise = (id) => {
  currentExercise = findExercise(id);
  repGoal = Math.max(6, currentExercise.duration);
  document.getElementById('workoutTitle').textContent = currentExercise.name;
  document.getElementById('workoutSubtitle').textContent = `${currentExercise.desc} · Camera-first coaching with real-time form feedback.`;
  show('workout');
};

// ===================== EXERCISE PREVIEW MODAL =====================
// Called with no id from the Workout page (previews whatever exercise is
// currently loaded there); called with an id from an Exercise Library card.
window.openExercisePreview = (id) => {
  const exercise = id ? findExercise(id) : currentExercise;
  openPreview(exercise);
};
window.closeExercisePreview = closePreview;
window.startFromPreview = () => {
  const exercise = activePreviewExercise();
  closePreview();
  if (exercise) window.startExercise(exercise.id);
};

// ===================== AI CHAT =====================
// Chat history is now a real per-account list of saved conversations (see
// chatHistory.js), rendered into the sidebar on the AI Coach page. Each
// conversation keeps its own message list; `activeChatId` tracks which one
// is currently open in the main chat pane.
const chatBody = document.getElementById('chatBody');
let chatBusy = false;
let activeChatId = null;

function escapeHTML(value) {
  const d = document.createElement('div');
  d.textContent = String(value ?? '');
  return d.innerHTML;
}
function formatTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
function ensureChat() {
  if (!activeChatId) {
    const chats = listChats();
    const c = chats[0] || createChat('New conversation');
    activeChatId = c.id;
  }
  return getChat(activeChatId) || createChat('New conversation');
}
function renderChatHistory() {
  const list = document.getElementById('chatHistoryList');
  if (!list) return;
  const chats = listChats();
  if (!chats.length) {
    list.innerHTML = '<div class="chatHistoryEmpty">Your conversations will appear here.<br><small>Start your first conversation.</small></div>';
    return;
  }
  list.innerHTML = chats.map((c) => `<button class="chatHistoryItem ${c.id === activeChatId ? 'active' : ''}" onclick="openChat('${c.id}')"><span class="chatHistoryIcon">◌</span><span class="chatHistoryMeta"><b>${escapeHTML(c.title || 'New conversation')}</b><small>${formatTime(c.updatedAt)}</small></span><span class="chatHistoryMenu" onclick="event.stopPropagation(); chatItemMenu('${c.id}')">⋯</span></button>`).join('');
}
function renderConversation() {
  if (!chatBody) return;
  const c = ensureChat();
  chatBody.innerHTML = '';
  const messages = c.messages?.length ? c.messages : [
    { role: 'assistant', content: "Hey! I'm FitPose AI. What would you like to improve today? ✨" },
    { role: 'assistant', content: 'I can help with exercise technique, posture, mobility, recovery and personalized workout guidance.' },
  ];
  messages.forEach((m) => appendMsg(m.via === 'voice' ? `🎤 ${m.content}` : m.content, m.role === 'user' ? 'you' : 'bot', m.timestamp));
}
function appendMsg(text, who = 'bot', timestamp = new Date().toISOString()) {
  const div = document.createElement('div');
  div.className = 'msgWrap ' + (who === 'you' ? 'msgWrapYou' : '');
  div.innerHTML = `<div class="msgAvatar">${who === 'you' ? 'U' : '✦'}</div><div class="msg ${who === 'you' ? 'you' : ''}">${escapeHTML(text)}<small class="msgTime">${formatTime(timestamp)}</small></div>`;
  chatBody.appendChild(div);
  chatBody.scrollTop = chatBody.scrollHeight;
}
function appendTyping() {
  const div = document.createElement('div');
  div.className = 'msgWrap';
  div.id = 'typingMsg';
  div.innerHTML = '<div class="msgAvatar">✦</div><div class="msg"><span class="typing"><i></i><i></i><i></i></span></div>';
  chatBody.appendChild(div);
  chatBody.scrollTop = chatBody.scrollHeight;
}

window.openChat = (id) => { activeChatId = id; renderConversation(); renderChatHistory(); document.getElementById('chatHistoryDrawer')?.classList.remove('open'); };
window.newChat = () => { const c = createChat('New conversation'); activeChatId = c.id; renderConversation(); renderChatHistory(); };
window.deleteActiveChat = () => { if (!activeChatId) return; deleteChat(activeChatId); activeChatId = null; renderConversation(); renderChatHistory(); toast('Conversation deleted', 'ok'); };
window.chatItemMenu = (id) => {
  const c = getChat(id);
  if (!c) return;
  const action = prompt('Type rename to rename or delete to delete this conversation:', 'rename');
  if (action === 'delete') {
    deleteChat(id);
    if (activeChatId === id) activeChatId = null;
    renderConversation();
    renderChatHistory();
  } else if (action === 'rename') {
    const title = prompt('Conversation name:', c.title);
    if (title) { renameChat(id, title); renderChatHistory(); }
  }
};
window.filterChatHistory = (value) => {
  const q = value.toLowerCase();
  document.querySelectorAll('.chatHistoryItem').forEach((x) => { x.style.display = x.textContent.toLowerCase().includes(q) ? 'flex' : 'none'; });
};
window.toggleChatHistory = () => document.getElementById('chatHistoryDrawer')?.classList.toggle('open');

async function sendMessage(text, { viaVoice = false } = {}) {
  const cleanText = String(text || '').trim();
  if (!cleanText || chatBusy) return null;

  const c = ensureChat();
  if (c.messages.length === 0) { c.title = cleanText.slice(0, 42) + (cleanText.length > 42 ? '…' : ''); }
  // `via` is display metadata only (adds the 🎤 marker below and on reload)
  // — `content` is the plain transcript, saved exactly like a typed message,
  // so the AI Coach conversation history/context is identical either way.
  const userMsg = { role: 'user', content: cleanText, timestamp: new Date().toISOString(), ...(viaVoice ? { via: 'voice' } : {}) };
  c.messages.push(userMsg);
  saveChat(c);
  appendMsg(viaVoice ? `🎤 ${cleanText}` : cleanText, 'you', userMsg.timestamp);
  renderChatHistory();
  appendTyping();
  chatBusy = true;

  const sendButton = document.getElementById('chatSend');
  const input = document.getElementById('chatInput');
  if (sendButton) sendButton.disabled = true;
  if (input) input.disabled = true;

  let reply = null;
  let plan = null;
  let schedule = null;

  try {
    if (isAICoachConfigured()) {
      const ai = await getAICoachReply(c.messages);
      if (ai?.reply) {
        reply = ai.reply;
        plan = ai.plan;
        schedule = ai.schedule;
      } else {
        reply = ai?.error || "I'm having trouble reaching FitPose AI right now. Please make sure the FitPose Flask backend is running and your OpenAI API key is configured, then try again.";
      }
    } else {
      reply = coachReply(cleanText);
    }
  } finally {
    document.getElementById('typingMsg')?.remove();
    chatBusy = false;
    if (sendButton) sendButton.disabled = false;
    if (input) input.disabled = false;
    if (input) input.focus();
  }

  const botMsg = { role: 'assistant', content: reply, timestamp: new Date().toISOString() };
  c.messages.push(botMsg);
  saveChat(c);
  appendMsg(reply, 'bot', botMsg.timestamp);
  renderChatHistory();

  if (plan && plan.exerciseIds?.length && plan.days) {
    Store.startRecoveryPlan(plan);
    renderPlanStatus();
    toast(`Recovery plan started: ${plan.days}-day ${plan.condition || 'plan'} 🌿`, 'ok');
  }

  if (schedule && schedule.exerciseIds?.length) {
    if (isPremium()) {
      Store.setSchedule({ exercises: schedule.exerciseIds, time: schedule.time || null, createdBy: 'ai', condition: schedule.goal || null });
      if (document.getElementById('schedule')?.classList.contains('active')) renderSchedule();
      toast('Your AI-generated schedule is ready ✦ — check the Schedule page', 'ok');
    } else {
      toast('AI-generated schedules need Premium — you can still build one yourself on the Schedule page.', 'err');
    }
  }

  return reply;
}
document.getElementById('chatSend').addEventListener('click', () => {
  const input = document.getElementById('chatInput');
  sendMessage(input.value);
  input.value = '';
});
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('chatSend').click();
  }
});
window.sendChip = (text) => sendMessage(text);

// ===================== ASSISTANT VOICE (mic input for the AI Coach) =======
// Existing Assistant Voice button (composer, #ai page) → microphone →
// /api/voice/transcribe (STT) → the SAME sendMessage()/AI Coach pipeline
// used for typed messages, above → /api/voice/speak (TTS) → speaker.
// Multilingual: whichever language FitPose's language selector is set to
// (getLanguage()) is passed as an STT hint and is already what makes the
// existing AI Coach reply in that language (see coach.js/ai_coach.py) —
// this file adds no separate AI logic of its own.
const assistantVoiceBtn = document.getElementById('assistantVoiceBtn');
const assistantVoiceStatus = document.getElementById('assistantVoiceStatus');
let voiceUiState = 'idle'; // idle | listening | transcribing | speaking

const VOICE_ICON = { idle: '🎤', listening: '🔴', transcribing: '⏳', speaking: '🔊' };
const VOICE_TITLE = {
  idle: 'Assistant Voice — tap to speak',
  listening: 'Listening… tap to stop',
  transcribing: 'Processing…',
  speaking: 'Speaking…',
};

function setVoiceUiState(state, statusText = '') {
  voiceUiState = state;
  if (assistantVoiceBtn) {
    assistantVoiceBtn.textContent = VOICE_ICON[state] || '🎤';
    assistantVoiceBtn.title = VOICE_TITLE[state] || 'Assistant Voice';
    assistantVoiceBtn.classList.toggle('recording', state === 'listening');
    assistantVoiceBtn.disabled = state === 'transcribing' || state === 'speaking';
  }
  if (assistantVoiceStatus) assistantVoiceStatus.textContent = statusText;
}

// Hoisted (function declaration) so show() above can call this safely
// regardless of source order — releases the mic if the user navigates away
// from the AI page mid-recording.
function cancelAssistantVoiceIfActive() {
  if (!assistantVoiceBtn) return;
  if (isRecording()) cancelRecording();
  if (voiceUiState !== 'idle') setVoiceUiState('idle');
}

if (assistantVoiceBtn) {
  if (!isMicSupported()) {
    assistantVoiceBtn.disabled = true;
    assistantVoiceBtn.title = 'Voice input is not supported in this browser';
  } else if (!isVoiceInputConfigured()) {
    assistantVoiceBtn.disabled = true;
    assistantVoiceBtn.title = 'Assistant Voice needs the FitPose backend configured';
  } else {
    setVoiceUiState('idle');
    assistantVoiceBtn.addEventListener('click', async () => {
      if (voiceUiState === 'listening') {
        setVoiceUiState('transcribing', 'Processing…');
        try {
          const { blob, mimeType } = await stopRecording();
          const transcript = await transcribeAudio(blob, mimeType, getLanguage());
          const reply = await sendMessage(transcript, { viaVoice: true });
          if (reply) {
            setVoiceUiState('speaking', 'Speaking…');
            await speakText(reply);
          }
        } catch (ex) {
          const message = ex instanceof NoSpeechError
            ? ex.message
            : (ex.message || "I couldn't understand the audio. Please try again.");
          toast(message, 'err');
        } finally {
          setVoiceUiState('idle');
        }
        return;
      }
      if (voiceUiState !== 'idle') return; // ignore taps while busy
      try {
        await startRecording();
        setVoiceUiState('listening', 'Listening…');
      } catch (ex) {
        const message = ex instanceof MicPermissionError
          ? ex.message
          : 'Microphone access is required for voice input.';
        toast(message, 'err');
        setVoiceUiState('idle');
      }
    });
  }
}

// ===================== PREMIUM / RESEARCH / REFERENCES =====================
window.openPremiumGate = (feature) => {
  const modal = document.getElementById('premiumGateModal');
  if (modal) { document.getElementById('premiumGateFeature').textContent = feature || 'this feature'; modal.classList.add('open'); }
};
window.closePremiumGate = () => document.getElementById('premiumGateModal')?.classList.remove('open');
window.activatePremium = () => {
  if (!Auth.isLoggedIn()) { show('login'); return; }
  activateDemoPremium();
  window.closePremiumGate();
  refreshAuthUI();
  renderProfile();
  toast('Welcome to FitPose Premium ✦', 'ok');
  show('premium');
  renderPremium();
};
window.cancelPremium = () => { cancelSubscription(); refreshAuthUI(); renderProfile(); renderPremium(); toast('Premium demo subscription cancelled'); };
function renderPremium() {
  const badge = document.getElementById('premiumStatusBadge');
  if (!badge) return;
  const p = isPremium();
  badge.textContent = p ? '✦ PREMIUM ACTIVE' : 'FREE PLAN';
  badge.className = 'premiumStatusBadge ' + (p ? 'active' : '');
  const status = document.getElementById('premiumStatusText');
  if (status) status.innerHTML = p ? 'Your Premium features are unlocked. <b>Demo subscription active.</b>' : 'You are currently on the Free plan.';
  const cta = document.getElementById('premiumCTA');
  if (cta) cta.textContent = p ? 'Manage Demo Subscription' : 'Unlock Premium';
  const manage = document.getElementById('premiumManage');
  if (manage) manage.style.display = p ? '' : 'none';
}
function renderResearch() { renderReferences(true); }
function renderReferences(researchOnly = false) {
  const el = document.getElementById(researchOnly ? 'researchGrid' : 'referenceGrid');
  if (!el) return;
  const refs = [
    ['WHO', 'Physical activity', 'General activity', 'Global physical activity guidance and health benefits.', 'High', 'https://www.who.int/news-room/fact-sheets/detail/physical-activity'],
    ['CDC', 'Physical Activity Basics', 'Exercise', 'General activity guidance and benefits.', 'High', 'https://www.cdc.gov/physical-activity/basics/index.html'],
    ['NICE', 'Low back pain and sciatica in over 16s', 'Physiotherapy', 'Clinical recommendations for assessment and management.', 'High', 'https://www.nice.org.uk/guidance/ng59'],
    ['NHS', 'Back pain', 'Musculoskeletal health', 'General information and warning symptoms.', 'High', 'https://www.nhs.uk/conditions/back-pain/'],
    ['NHS', 'Sprains and strains', 'Injury', 'General information about common soft-tissue injuries.', 'High', 'https://www.nhs.uk/conditions/sprains-and-strains/'],
    ['NHS', 'Sciatica', 'Musculoskeletal health', 'General information about radiating back and leg pain.', 'High', 'https://www.nhs.uk/conditions/sciatica/'],
    ['NICE', 'Osteoarthritis in over 16s', 'Joint health', 'Evidence-based recommendations for osteoarthritis management.', 'High', 'https://www.nice.org.uk/guidance/ng226'],
    ['ACSM', 'Education & Resources', 'Exercise science', 'Professional exercise science resources.', 'High', 'https://www.acsm.org/education-resources'],
  ];
  el.innerHTML = refs.map((r) => `<article class="referenceCard"><div class="referenceTop"><span class="referenceOrg">${r[0]}</span><span class="evidencePill">${r[4]} evidence</span></div><h3>${r[1]}</h3><span class="referenceTopic">${r[2]}</span><p class="muted">${r[3]}</p><div class="referenceBottom"><span>Verified source</span><a href="${r[5]}" target="_blank" rel="noopener">View source ↗</a></div></article>`).join('');
}

// ===================== RECOVERY PLAN STATUS =====================
function renderPlanStatus() {
  const card = document.getElementById('planStatusCard');
  if (!card) return;
  const plan = Auth.isLoggedIn() ? Store.getRecoveryPlan() : null;
  if (!plan) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  const dayNum = Math.min(plan.completedDates.length + (plan.active ? 1 : 0), plan.totalDays);
  const pct = Math.round((plan.completedDates.length / plan.totalDays) * 100);
  const names = plan.exerciseIds.map((id) => findExercise(id).name).join(', ');
  document.getElementById('planStatusTitle').textContent = plan.active
    ? `Day ${dayNum} of ${plan.totalDays} — ${plan.condition}`
    : `${plan.condition} plan complete 🎉`;
  document.getElementById('planStatusDetail').textContent = plan.active
    ? `Today: ${names} · plan streak ${plan.streak} day(s)`
    : `You completed all ${plan.totalDays} days — nice consistency.`;
  document.getElementById('planStatusBar').style.setProperty('--w', `${Math.min(100, pct)}%`);
  const actions = document.getElementById('planStatusActions');
  actions.innerHTML = plan.active
    ? plan.exerciseIds.map((id) => `<button class="btn primary smallbtn" onclick="startExercise('${id}')">Start ${findExercise(id).name} →</button>`).join(' ')
    : '';
}

// ===================== WORKOUT / LIVE SESSION =====================
let camStream = null;
let currentExercise = findExercise('squat');
let repGoal = Math.max(6, currentExercise.duration);
let analyzer = new ExerciseAnalyzer();
let rafId = null;
let sessionStartTs = null;
let sessionTimerInterval = null;
let formScoreSamples = [];
let modelReady = false;

const video = document.getElementById('webcam');
const poseCanvas = document.getElementById('poseCanvas');
const poseCtx = poseCanvas?.getContext('2d');
let sessionPaused = false;

function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function syncPoseCanvasSize() {
  if (!poseCanvas || !video.videoWidth || !video.videoHeight) return;
  if (poseCanvas.width !== video.videoWidth || poseCanvas.height !== video.videoHeight) {
    poseCanvas.width = video.videoWidth;
    poseCanvas.height = video.videoHeight;
  }
}

// Landmarks worth drawing joints on — the full 33-point face ring (1-10) is
// used for angle math elsewhere but is too dense/twitchy to render usefully
// as dots on a small preview, so the overlay sticks to the body + nose.
const OVERLAY_JOINTS = [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];

function drawPoseOverlay(landmarks) {
  if (!poseCanvas || !poseCtx) return;
  syncPoseCanvasSize();
  if (!poseCanvas.width || !poseCanvas.height) return;
  poseCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
  if (!landmarks?.length) return;

  // Lowered from 0.45: the lite BlazePose model routinely reports legs/feet
  // (knees, ankles, heels, toes) at 0.3-0.45 confidence even when clearly
  // visible, which was silently dropping those connections and leaving the
  // on-screen skeleton looking upper-body-only / missing limbs. 0.3 still
  // filters out genuinely occluded/guessed points.
  const visible = (index) => (landmarks[index]?.visibility ?? 0) >= 0.3;
  const baseWidth = Math.max(2.5, poseCanvas.width / 480);
  poseCtx.lineCap = 'round';
  poseCtx.lineJoin = 'round';

  // z is roughly hip-depth-relative (negative = closer to camera). Map it to
  // a soft multiplier so nearer limbs read as slightly thicker/brighter —
  // a cheap depth cue that makes the skeleton look more three-dimensional
  // instead of a flat wireframe.
  const depthScale = (index) => {
    const z = landmarks[index]?.z ?? 0;
    return Math.max(0.75, Math.min(1.35, 1 - z * 1.4));
  };

  // Draws one glow+core bone between two already-resolved points, each with
  // its own visibility/confidence and depth scale. Pulled out so the synthetic
  // neck bone below can share the exact same rendering as the POSE_CONNECTIONS
  // loop instead of duplicating the glow/core styling.
  const drawBone = (pa, pb, confA, confB, scaleA, scaleB) => {
    const conf = Math.min(confA, confB);
    const scale = (scaleA + scaleB) / 2;
    poseCtx.lineCap = 'round';
    poseCtx.strokeStyle = `rgba(75, 235, 195, ${0.18 * conf})`;
    poseCtx.lineWidth = baseWidth * scale * 2.4;
    poseCtx.beginPath();
    poseCtx.moveTo(pa.x * poseCanvas.width, pa.y * poseCanvas.height);
    poseCtx.lineTo(pb.x * poseCanvas.width, pb.y * poseCanvas.height);
    poseCtx.stroke();
    poseCtx.strokeStyle = `rgba(75, 235, 195, ${0.65 + 0.3 * conf})`;
    poseCtx.lineWidth = baseWidth * scale;
    poseCtx.stroke();
  };

  // Full 33-point BlazePose connection set (imported from pose.js so the
  // overlay always matches whatever MediaPipe actually returns), instead of
  // the previous hardcoded 14-line limb-only subset.
  for (const [a, b] of POSE_CONNECTIONS) {
    if (!visible(a) || !visible(b)) continue;
    drawBone(
      landmarks[a], landmarks[b],
      landmarks[a].visibility ?? 0, landmarks[b].visibility ?? 0,
      depthScale(a), depthScale(b)
    );
  }

  // BlazePose has no explicit "neck" landmark, and POSE_CONNECTIONS (mirroring
  // MediaPipe's own default connection set) never links the face ring to the
  // shoulders — so the head has always rendered as visually detached from the
  // torso, with a gap where the neck should be. Synthesized here once (used
  // by both the bone-drawing and dot-drawing passes below) as two points:
  //   neckPoint — shoulder midpoint (base of the neck)
  //   neckBase  — midpoint between the nose and neckPoint (upper neck / throat
  //               level), wired to both shoulders individually so lateral
  //               head tilt shows up as an asymmetric V instead of just a
  //               straight vertical line, which is what actually lets you
  //               read neck tilt/rotation off the overlay.
  // Landmark indices: 0 = nose, 11 = left shoulder, 12 = right shoulder
  // (same BlazePose numbering used throughout this file, e.g. OVERLAY_JOINTS).
  let neckGeom = null;
  if (visible(0) && visible(11) && visible(12)) {
    const nose = landmarks[0];
    const ls = landmarks[11];
    const rs = landmarks[12];
    const noseConf = nose.visibility ?? 0;
    const lsConf = ls.visibility ?? 0;
    const rsConf = rs.visibility ?? 0;

    const neckPoint = {
      x: (ls.x + rs.x) / 2,
      y: (ls.y + rs.y) / 2,
      z: ((ls.z ?? 0) + (rs.z ?? 0)) / 2,
    };
    const neckConf = Math.min(lsConf, rsConf, noseConf);
    const neckScale = Math.max(0.75, Math.min(1.35, 1 - neckPoint.z * 1.4));

    const neckBase = {
      x: (nose.x + neckPoint.x) / 2,
      y: (nose.y + neckPoint.y) / 2,
      z: ((nose.z ?? 0) + neckPoint.z) / 2,
    };
    const neckBaseConf = neckConf;
    const neckBaseScale = Math.max(0.75, Math.min(1.35, 1 - neckBase.z * 1.4));

    neckGeom = {
      nose, ls, rs, noseConf, lsConf, rsConf,
      neckPoint, neckConf, neckScale,
      neckBase, neckBaseConf, neckBaseScale,
    };
  }

  if (neckGeom) {
    const { nose, ls, rs, noseConf, lsConf, rsConf, neckPoint, neckConf, neckScale, neckBase, neckBaseConf, neckBaseScale } = neckGeom;
    // nose -> neckBase -> neckPoint (subdivides the old single neck line)
    drawBone(nose, neckBase, noseConf, neckBaseConf, depthScale(0), neckBaseScale);
    drawBone(neckBase, neckPoint, neckBaseConf, neckConf, neckBaseScale, neckScale);
    // neckBase -> each shoulder, independent of the neckPoint/shoulder line,
    // so the two sides can be measured against each other for tilt/rotation.
    drawBone(neckBase, ls, neckBaseConf, lsConf, neckBaseScale, depthScale(11));
    drawBone(neckBase, rs, neckBaseConf, rsConf, neckBaseScale, depthScale(12));
  }

  for (const index of OVERLAY_JOINTS) {
    if (!visible(index)) continue;
    const point = landmarks[index];
    const conf = point.visibility ?? 0;
    const radius = Math.max(3, (poseCanvas.width / 160) * depthScale(index));
    poseCtx.beginPath();
    poseCtx.arc(point.x * poseCanvas.width, point.y * poseCanvas.height, radius, 0, Math.PI * 2);
    poseCtx.fillStyle = `rgba(105, 215, 255, ${0.55 + 0.43 * conf})`;
    poseCtx.fill();
    poseCtx.lineWidth = Math.max(1, radius / 4);
    poseCtx.strokeStyle = 'rgba(10, 25, 30, 0.55)';
    poseCtx.stroke();
  }

  // Dots for the two synthesized neck points, drawn after the main joint loop
  // so they don't need to be threaded through OVERLAY_JOINTS (neither is a
  // real BlazePose landmark index).
  if (neckGeom) {
    const drawJointDot = (point, conf, scale) => {
      const radius = Math.max(3, (poseCanvas.width / 160) * scale);
      poseCtx.beginPath();
      poseCtx.arc(point.x * poseCanvas.width, point.y * poseCanvas.height, radius, 0, Math.PI * 2);
      poseCtx.fillStyle = `rgba(105, 215, 255, ${0.55 + 0.43 * conf})`;
      poseCtx.fill();
      poseCtx.lineWidth = Math.max(1, radius / 4);
      poseCtx.strokeStyle = 'rgba(10, 25, 30, 0.55)';
      poseCtx.stroke();
    };
    drawJointDot(neckGeom.neckBase, neckGeom.neckBaseConf, neckGeom.neckBaseScale);
    drawJointDot(neckGeom.neckPoint, neckGeom.neckConf, neckGeom.neckScale);
  }
}

function updateSessionAssist(analysis, spokenText = null) {
  const list = document.getElementById('improvementSuggestions');
  const status = document.getElementById('assistStatus');
  const voiceText = document.getElementById('voiceAssistantText');
  const voiceStatus = document.getElementById('voiceTextStatus');
  if (!list || !status || !voiceText) return;

  if (analysis.accuracy <= 0) {
    status.textContent = 'Waiting for a clear pose';
    list.innerHTML = '<li>Step far enough back to keep your full body visible.</li><li>Use steady lighting and keep the camera at about waist-to-chest height.</li><li>Move slowly at first so MediaPipe can lock onto your landmarks.</li>';
  } else {
    status.textContent = `${analysis.accuracy}% form · ${Math.round((analysis.confidence_score || 0) * 100)}% confidence`;
    const suggestions = analysis.detected_issues?.filter((item) => item && !/^None/i.test(item)) || [];
    const primary = analysis.personalized_correction && !/^Maintain your alignment/i.test(analysis.personalized_correction)
      ? [analysis.personalized_correction]
      : [];
    const merged = [...primary, ...suggestions].filter((item, index, arr) => arr.indexOf(item) === index).slice(0, 3);
    list.innerHTML = (merged.length ? merged : [
      'Keep the movement smooth and controlled.',
      'Complete the full range of motion before returning to the start position.',
      'Stay centered so all required landmarks remain visible.'
    ]).map((item) => `<li>${item}</li>`).join('');
  }

  if (spokenText) {
    voiceText.textContent = spokenText;
    voiceStatus.textContent = 'Latest coaching';
  } else if (analysis.accuracy <= 0) {
    voiceText.textContent = 'I am waiting to see a clear, stable full-body pose.';
    voiceStatus.textContent = 'Waiting';
  }
}

window.startSession = async () => {
  const overlay = document.getElementById('camOverlay');
  const scan = document.getElementById('scanLine');
  const camOff = document.getElementById('camOff');
  const btn = document.getElementById('startBtn');
  const modelStatus = document.getElementById('modelStatus');
  const modelStatusText = document.getElementById('modelStatusText');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('This browser cannot access the camera. Try Chrome, Edge, or Safari over HTTPS.', 'err');
    return;
  }
  // Fired synchronously inside this click handler (before any `await`) so
  // Safari/iOS — which requires speech synthesis to start within a direct
  // user-gesture call stack — still lets the intro line play.
  const sessionIntroText = announceSessionStart(currentExercise.target);
  document.getElementById('voiceAssistantText').textContent = sessionIntroText || 'FitPose AI is ready to coach you.';
  document.getElementById('voiceTextStatus').textContent = 'Session started';
  btn.textContent = 'Requesting camera…';
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = camStream;
    // The `autoplay` attribute alone can silently fail to start playback here
    // since we're past an `await` (outside some browsers' direct user-gesture
    // chain) — without an actual playing <video>, videoWidth/readyState never
    // advance, so the detection loop below never has a frame to feed MediaPipe.
    await video.play();
    syncPoseCanvasSize();
    drawPoseOverlay(null);
    overlay.classList.add('hidden');
    scan.style.display = 'block';
    camOff.style.display = 'none';
  } catch (err) {
    toast('Camera access was blocked or unavailable. Please allow camera permission and try again.', 'err');
    btn.innerHTML = '<span class="dot-rec"></span> Start Live Session';
    return;
  }

  analyzer.reset();
  formScoreSamples = [];
  sessionPaused = false;
  document.getElementById('repCount').textContent = '00';
  document.getElementById('voiceAssistantText').textContent = sessionIntroText || 'FitPose AI is watching your movement. Your spoken guidance will appear here as text.';
  document.getElementById('voiceTextStatus').textContent = 'Listening';
  updateSessionAssist({ accuracy: 0, confidence_score: 0 });
  sessionStartTs = Date.now();
  sessionTimerInterval = setInterval(() => {
    if (sessionPaused) return;
    const elapsed = (Date.now() - sessionStartTs) / 1000;
    document.getElementById('sessionTime').textContent = fmtTime(elapsed);
  }, 500);
  showSessionControls();

  try {
    if (!modelReady) {
      modelStatus.classList.add('show');
      await loadPoseLandmarker((status) => {
        if (status) modelStatusText.textContent = status;
      });
      modelReady = true;
    }
    modelStatus.classList.remove('show');
    runDetectionLoop();
  } catch (err) {
    modelStatusText.textContent = 'AI model failed to load — check your connection.';
    toast('Could not load the on-device AI model. Check your internet connection.', 'err');
  }
};

function runDetectionLoop() {
  const loop = () => {
    if (!camStream) return;
    if (!sessionPaused && video.readyState >= 2 && video.videoWidth) {
      // Pose detection runs every frame. The same MediaPipe landmarks drive
      // the visible skeleton overlay, form analysis, rep counting, and coaching
      // entirely on-device.
      let result = null;
      try {
        result = detectForVideo(video, performance.now());
      } catch (err) {
        drawPoseOverlay(null);
        document.getElementById('modelStatusText').textContent = 'Pose tracking paused — recovering…';
      }
      const landmarks = result?.landmarks?.[0] || null;
      drawPoseOverlay(landmarks);
      const analysis = analyzer.analyze(landmarks, currentExercise.id);
      updateSessionUI(analysis);
      const spokenText = speakAnalysis(analysis);
      updateSessionAssist(analysis, spokenText);
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function updateSessionUI(analysis) {
  document.getElementById('repCount').textContent = String(analysis.rep_count).padStart(2, '0');
  const formEl = document.getElementById('formScore');
  formEl.textContent = analysis.accuracy ? analysis.accuracy + '%' : '--%';
  const aiTitle = document.getElementById('aiFeedbackTitle');
  const aiDetail = document.getElementById('aiFeedbackDetail');
  const aiBar = document.getElementById('aiFeedbackBar');
  const aiChip = document.getElementById('aiFeedbackChip');

  if (analysis.accuracy > 0) {
    formScoreSamples.push(analysis.accuracy);
    const ok = analysis.posture_status === 'Correct posture';
    aiTitle.textContent = ok ? "You're doing great." : analysis.personalized_correction;
    aiDetail.textContent = analysis.feedback;
    aiBar.style.setProperty('--w', analysis.accuracy + '%');
    aiChip.textContent = ok ? 'AI feedback · on track' : 'AI feedback · adjust form';
    aiChip.className = 'chip ' + (ok ? 'pill-good' : 'pill-warn');
  } else {
    aiTitle.textContent = 'Get in frame to begin.';
    aiDetail.textContent = analysis.personalized_correction;
  }

  document.getElementById('sessionConfidence').textContent = Math.round((analysis.confidence_score || 0) * 100) + '%';

  if (analysis.rep_count >= repGoal) {
    document.getElementById('cameraFrame').classList.add('repGoalDone');
  }
}

// ===================== IN-FRAME PAUSE / STOP CONTROLS =====================
let pausedAt = null;

function showSessionControls() {
  const bar = document.getElementById('sessionControls');
  if (!bar) return;
  bar.classList.add('show');
  const pauseBtn = document.getElementById('pauseSessionBtn');
  if (pauseBtn) pauseBtn.innerHTML = '⏸ Pause';
}

function hideSessionControls() {
  document.getElementById('sessionControls')?.classList.remove('show');
}

window.togglePauseSession = () => {
  const pauseBtn = document.getElementById('pauseSessionBtn');
  if (!camStream) return;
  sessionPaused = !sessionPaused;
  if (sessionPaused) {
    pausedAt = Date.now();
    video.pause();
    stopSpeaking();
    if (pauseBtn) pauseBtn.innerHTML = '▶ Resume';
    toast('Session paused', 'ok');
  } else {
    // Shift the session start forward by however long we were paused, so
    // the on-screen timer and saved duration skip the paused time.
    if (pausedAt) sessionStartTs += Date.now() - pausedAt;
    pausedAt = null;
    video.play().catch(() => {});
    if (pauseBtn) pauseBtn.innerHTML = '⏸ Pause';
    toast('Session resumed', 'ok');
  }
};

window.stopSessionFromControls = () => {
  window.finishSession();
};

window.finishSession = () => {
  const durationSec = sessionStartTs ? (Date.now() - sessionStartTs) / 1000 : 0;
  const reps = Number(document.getElementById('repCount').textContent) || 0;
  const avgForm = formScoreSamples.length
    ? Math.round(formScoreSamples.reduce((a, b) => a + b, 0) / formScoreSamples.length)
    : 0;
  if (durationSec >= 5 && Auth.isLoggedIn()) {
    Store.recordSession({
      exercise: currentExercise.id,
      exerciseLabel: currentExercise.name,
      durationSec,
      reps,
      avgForm: avgForm || 80,
    });
    renderPlanStatus();
    toast(`Session saved — ${reps} reps, ${Math.round(durationSec)}s 🎉`, 'ok');
  } else if (!Auth.isLoggedIn()) {
    toast('Sign in to save your sessions to your progress history.', 'err');
  }
  if (durationSec >= 5) announceSessionEnd({ reps, avgForm: avgForm || 0 });
  stopSession({ cancelVoice: false }); // let the just-spoken summary finish playing
  show('dashboard');
};

function stopSession({ cancelVoice = true } = {}) {
  if (cancelVoice) stopSpeaking();
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionTimerInterval = null;
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  sessionPaused = false;
  pausedAt = null;
  hideSessionControls();
  document.getElementById('cameraFrame')?.classList.remove('repGoalDone');
  const overlay = document.getElementById('camOverlay');
  const scan = document.getElementById('scanLine');
  const camOff = document.getElementById('camOff');
  const btn = document.getElementById('startBtn');
  if (video) video.srcObject = null;
  drawPoseOverlay(null);
  if (overlay) overlay.classList.remove('hidden');
  if (scan) scan.style.display = 'none';
  if (camOff) camOff.style.display = 'grid';
  if (btn) btn.innerHTML = '<span class="dot-rec"></span> Start Live Session';
  document.getElementById('sessionTime').textContent = '00:00';
  document.getElementById('repCount').textContent = '00';
  document.getElementById('formScore').textContent = '--%';
  document.getElementById('sessionConfidence').textContent = '--%';
}
window.addEventListener('beforeunload', stopSession);

// ===================== INIT =====================
// If a Google-linked account has a still-valid cloud session token from a
// previous visit, this restores it (and their saved progress) before the
// first render, so the site opens already signed in.
Auth.tryCloudAutoLogin().finally(() => {
  refreshAuthUI();
  renderLibrary('All');
  const hash = location.hash.replace('#', '');
  show(pages.includes(hash) ? hash : 'home');
});
