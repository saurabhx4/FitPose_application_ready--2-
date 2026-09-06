// ===== FitPose data layer: auth + per-user workout data =====
// Sign-in identity now comes from real Google OAuth (Google Identity
// Services) — see Auth.loginWithGoogle() below, which talks to Google's
// actual servers and gets back a verified profile, no mock/demo account.
// There is no backend/database in this project, so once a person's identity
// is established their account record, app password hash, and workout data
// are still persisted in this browser's localStorage. Swap dataKey()/
// readJSON()/writeJSON() for real API calls to your own backend whenever you
// stand one up — nothing else in the app talks to storage directly.
//
// Google sign-in setup (required for the "Continue with Google" button to
// work): create an OAuth 2.0 Client ID (type "Web application") in Google
// Cloud Console → APIs & Services → Credentials, add your dev/prod URLs
// under "Authorized JavaScript origins", then put the client ID in a
// `.env` file as VITE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
// (see .env.example). Nothing here will work without a real client ID.

import { EXERCISES, findExercise } from './exercises.js';
import { DEFAULT_LANGUAGE, isSupportedLanguage } from './i18n/languages.js';

const GOOGLE_CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID || '';
// Base URL of the backend in backend/app.py (see backend/.env.example). When
// unset, Google sign-in still works locally exactly as before — cloud save
// and token auto-login below just no-op.
const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';

const USERS_KEY = 'fitpose_users_v1';
const SESSION_KEY = 'fitpose_session_v1';
const CLOUD_TOKEN_KEY = 'fitpose_cloud_token_v1';
// Guest fallback only — used when nobody is signed in yet, so the language
// picked on e.g. the login screen still sticks. Once signed in, the
// preference lives on that account's own data record (see defaultUserData
// below) and is persisted/synced through the exact same Store.save() /
// CloudSync path as every other field, per-account rather than per-browser.
const GUEST_LANGUAGE_KEY = 'fitpose_guest_language_v1';
const dataKey = (email) => `fitpose_data_v1_${email.toLowerCase()}`;

// ---- tiny helpers ----
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---- default per-user data shape ----
// Every field here starts at a true zero/empty state. A brand-new user (via
// email/password OR Google) gets nothing pre-filled — no sample sessions, no
// calendar activity, no streak, no suggested goals. Everything fills in only
// as that person actually uses the app, timestamped with real dates.
function defaultUserData(name) {
  return {
    goals: [],
    sessions: [], // {date, time, exercise, exerciseLabel, durationSec, reps, avgForm, calories}
    calendarDays: {}, // '2026-08-16': totalMinutes, filled in only on real recorded sessions
    stats: { streak: 0, bestStreak: 0 },
    recoveryPlan: null, // {condition, exerciseIds, totalDays, startedAt, completedDates, active, streak, bestStreak} — see AI Coach (coach.js)
    schedule: null, // {exercises:[exerciseId,...], time, createdBy:'manual'|'ai', condition, updatedAt} — see Schedule page below
    membership: { plan: 'free', isPremium: false, startedAt: null, expiresAt: null, demo: false },
    name,
    preferredLanguage: DEFAULT_LANGUAGE, // ISO 639-1 code — see src/js/i18n/languages.js
    ageGroup: '', // 'under18' | '18-60' | '60plus'
    gender: '',
  };
}

// ---- Google Identity Services loader ----
let googleScriptPromise = null;
function loadGoogleScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not reach Google — check your internet connection.'));
    document.head.appendChild(s);
  });
  return googleScriptPromise;
}

// Create (first time) or update (returning) the local account record for a
// person whose identity Google just verified, keyed by their real Google
// account email. No password is set for a brand-new Google account — see
// Auth.setAppPassword for how they add one later.
function upsertGoogleUser(profile) {
  const users = readJSON(USERS_KEY, {});
  const key = profile.email.trim().toLowerCase();
  if (!users[key]) {
    users[key] = {
      name: profile.name || profile.email.split('@')[0],
      email: key,
      googleId: profile.sub,
      picture: profile.picture || null,
      passwordHash: null,
      createdAt: Date.now(),
    };
    writeJSON(USERS_KEY, users);
    writeJSON(dataKey(key), defaultUserData(users[key].name));
  } else {
    users[key].googleId = profile.sub;
    if (profile.picture) users[key].picture = profile.picture;
    if (profile.name) users[key].name = users[key].name || profile.name;
    writeJSON(USERS_KEY, users);
  }
  return users[key];
}

// ---- Google Cloud persistence (backend/app.py + backend/cloud_store.js) ----
// Per-account data for Google-linked accounts is pushed to Google Cloud
// (Firestore, via the backend) whenever it's saved locally, and pulled back
// down on sign-in / token auto-login so progress follows the account across
// devices/browsers. Email+password-only accounts are unaffected — they keep
// using local storage only, same as before. Every call here is best-effort:
// if the backend isn't configured (no VITE_API_BASE_URL) or unreachable,
// the local copy already saved is what the app keeps using.
const CloudSync = {
  async signIn(accessToken) {
    if (!API_BASE) return null;
    const res = await fetch(`${API_BASE}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Could not reach cloud storage.');
    return res.json(); // { sessionToken, user, data }
  },
  async pull(token) {
    if (!API_BASE || !token) return null;
    const res = await fetch(`${API_BASE}/api/session`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return res.json(); // { user, data }
  },
  push(email, data) {
    if (!API_BASE) return;
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token) return;
    const users = readJSON(USERS_KEY, {});
    if (!users[email]?.googleId) return; // cloud sync is only for Google-linked accounts
    fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    }).catch(() => {}); // best-effort — the local copy is already saved
  },
};

// ===================== AUTH =====================
export const Auth = {
  async signup(name, email, password) {
    const users = readJSON(USERS_KEY, {});
    const key = email.trim().toLowerCase();
    if (users[key]) throw new Error('An account with this email already exists.');
    const passwordHash = await sha256(password);
    users[key] = { name: name.trim(), email: key, passwordHash, createdAt: Date.now() };
    writeJSON(USERS_KEY, users);
    if (!readJSON(dataKey(key), null)) writeJSON(dataKey(key), defaultUserData(name.trim()));
    Auth.setSession(key);
    return users[key];
  },

  async login(email, password) {
    const users = readJSON(USERS_KEY, {});
    const key = email.trim().toLowerCase();
    const user = users[key];
    if (!user) throw new Error('No account found with that email.');
    if (!user.passwordHash) {
      throw new Error('This account signed up with Google and has no app password yet. Continue with Google, or set a password from your Profile once signed in.');
    }
    const passwordHash = await sha256(password);
    if (passwordHash !== user.passwordHash) throw new Error('Incorrect password.');
    Auth.setSession(key);
    return user;
  },

  // Real "Continue with Google" — uses Google Identity Services' OAuth2 token
  // flow to open Google's actual account picker/consent screen, then verifies
  // the resulting access token by calling Google's own userinfo endpoint.
  // Nothing about the identity here is faked or stored client-side only.
  async loginWithGoogle() {
    if (!GOOGLE_CLIENT_ID) {
      throw new Error('Google Sign-In is not configured. Add VITE_GOOGLE_CLIENT_ID to a .env file (see .env.example) with a real OAuth Client ID from Google Cloud Console.');
    }
    await loadGoogleScript();
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'openid email profile',
        callback: async (resp) => {
          settled = true;
          if (!resp || resp.error) {
            reject(new Error('Google sign-in was cancelled or failed.'));
            return;
          }
          try {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${resp.access_token}` },
            });
            if (!res.ok) throw new Error('Could not verify your Google account.');
            const profile = await res.json(); // real, Google-verified: { sub, email, name, picture, email_verified }
            if (!profile.email) throw new Error('Google did not return an email address for this account.');
            const user = upsertGoogleUser(profile);
            Auth.setSession(user.email);
            // Best-effort: hand the same Google-verified access token to our
            // backend so it can persist this account + data to Google Cloud
            // and give us a token for automatic sign-in next visit. If the
            // backend isn't configured/reachable, this just no-ops and the
            // account keeps working from local storage as it already did.
            try {
              const cloud = await CloudSync.signIn(resp.access_token);
              if (cloud) {
                localStorage.setItem(CLOUD_TOKEN_KEY, cloud.sessionToken);
                if (cloud.data) writeJSON(dataKey(user.email), cloud.data);
              }
            } catch {
              // no cloud configured / unreachable — local-only for now
            }
            resolve(user);
          } catch (ex) {
            reject(ex);
          }
        },
        error_callback: () => {
          if (!settled) reject(new Error('Google sign-in was cancelled or failed.'));
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    });
  },

  // Lets a signed-in user (typically one who arrived via Google) set their
  // own separate email + password credential, so next time they can sign in
  // without going through Google at all.
  async setAppPassword(password) {
    const email = Auth.currentEmail();
    if (!email) throw new Error('Sign in first to set a password.');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
    const users = readJSON(USERS_KEY, {});
    const user = users[email];
    if (!user) throw new Error('Account not found.');
    user.passwordHash = await sha256(password);
    writeJSON(USERS_KEY, users);
    return true;
  },

  async resetPassword(email) {
    const users = readJSON(USERS_KEY, {});
    const key = email.trim().toLowerCase();
    const user = users[key];
    if (!user) throw new Error('No account found with that email.');
    const tempPassword = Math.random().toString(36).slice(2, 10);
    user.passwordHash = await sha256(tempPassword);
    writeJSON(USERS_KEY, users);
    return tempPassword;
  },

  setSession(email) {
    localStorage.setItem(SESSION_KEY, email);
  },
  logout() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CLOUD_TOKEN_KEY);
  },

  // Called once at app startup. If a Google-linked account previously
  // signed in and a cloud session token is still stored, this verifies it
  // with the backend and — on success — signs the person back in with their
  // previously saved progress already restored, with no action from them.
  async tryCloudAutoLogin() {
    const token = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (!token) return false;
    try {
      const cloud = await CloudSync.pull(token);
      if (!cloud) { localStorage.removeItem(CLOUD_TOKEN_KEY); return false; }
      const users = readJSON(USERS_KEY, {});
      const key = cloud.user.email.trim().toLowerCase();
      users[key] = {
        ...(users[key] || {}),
        name: cloud.user.name,
        email: key,
        googleId: cloud.user.sub,
        picture: cloud.user.picture || users[key]?.picture || null,
        passwordHash: users[key]?.passwordHash ?? null,
        createdAt: users[key]?.createdAt ?? Date.now(),
      };
      writeJSON(USERS_KEY, users);
      if (cloud.data) writeJSON(dataKey(key), cloud.data);
      Auth.setSession(key);
      return true;
    } catch {
      return false;
    }
  },
  currentEmail() {
    return localStorage.getItem(SESSION_KEY);
  },
  currentUser() {
    const email = Auth.currentEmail();
    if (!email) return null;
    const users = readJSON(USERS_KEY, {});
    return users[email] || null;
  },
  isLoggedIn() {
    return !!Auth.currentEmail();
  },
};

// ===================== USER DATA / STATS =====================
export const Store = {
  get() {
    const email = Auth.currentEmail();
    if (!email) {
      const guest = defaultUserData('Guest');
      guest.preferredLanguage = readJSON(GUEST_LANGUAGE_KEY, DEFAULT_LANGUAGE);
      return guest;
    }
    const existing = readJSON(dataKey(email), null);
    if (existing) {
      // Backfill for accounts created before preferredLanguage existed.
      if (!isSupportedLanguage(existing.preferredLanguage)) existing.preferredLanguage = DEFAULT_LANGUAGE;
      return existing;
    }
    const user = Auth.currentUser();
    const fresh = defaultUserData(user ? user.name : 'Guest');
    writeJSON(dataKey(email), fresh);
    return fresh;
  },

  save(data) {
    const email = Auth.currentEmail();
    if (!email) return;
    writeJSON(dataKey(email), data);
    CloudSync.push(email, data); // best-effort; no-op unless Google-linked + cloud configured
  },

  addGoal(goal) {
    const data = Store.get();
    data.goals.push(goal);
    Store.save(data);
    return data;
  },
  removeGoal(index) {
    const data = Store.get();
    data.goals.splice(index, 1);
    Store.save(data);
    return data;
  },

  // Record a finished workout session and roll it into streak/calendar/stats.
  // Calories scale with BOTH the exercise selected (its calorieRate) and the
  // real elapsed runtime of that session, not a single flat number.
  recordSession({ exercise, exerciseLabel, durationSec, reps, avgForm }) {
    const data = Store.get();
    const date = todayISO();
    const rate = findExercise(exercise)?.calorieRate ?? 5;
    const calories = Math.max(1, Math.round((durationSec / 60) * rate));
    data.sessions.unshift({
      date,
      time: new Date().toISOString(),
      exercise,
      exerciseLabel,
      durationSec,
      reps,
      avgForm,
      calories,
    });
    data.calendarDays[date] = (data.calendarDays[date] || 0) + durationSec / 60;
    data.stats.streak = Store._computeStreak(data.calendarDays);
    data.stats.bestStreak = Math.max(data.stats.bestStreak || 0, data.stats.streak);
    Store._progressRecoveryPlan(data, exercise, date);
    Store.save(data);
    return data;
  },

  // ----- AI Coach recovery plans (see src/js/coach.js) -----
  // A plan is created from a chat conversation once the AI Coach has enough
  // info (the problem + how long it's been going on) to prescribe specific
  // exercises from EXERCISES for a specific number of days. Its own streak
  // only counts days where the person actually did one of the PRESCRIBED
  // exercises — separate from the general all-exercise streak above.
  startRecoveryPlan({ exerciseIds, days, condition }) {
    const data = Store.get();
    data.recoveryPlan = {
      condition: condition || 'your plan',
      exerciseIds,
      totalDays: days,
      startedAt: todayISO(),
      completedDates: [],
      active: true,
      streak: 0,
      bestStreak: 0,
    };
    Store.save(data);
    return data.recoveryPlan;
  },

  getRecoveryPlan() {
    return Store.get().recoveryPlan || null;
  },

  cancelRecoveryPlan() {
    const data = Store.get();
    if (data.recoveryPlan) data.recoveryPlan.active = false;
    Store.save(data);
    return data;
  },

  // ----- Schedule (Schedule page) -----
  // A single ordered queue of exercises the user builds for their own
  // routine (added manually one at a time, or generated in one shot by the
  // AI Coach — see aiGenerateSchedule()/sendMessage() in app.js), plus an
  // optional preferred time of day. Replaces the old fixed mon..sun grid.
  getSchedule() {
    return Store.get().schedule || null;
  },

  hasSchedule() {
    const s = Store.get().schedule;
    return !!(s && Array.isArray(s.exercises) && s.exercises.length);
  },

  // Full replace — used both by the manual builder's "Save schedule" and by
  // an AI-Coach-generated schedule once premium has been confirmed.
  setSchedule({ exercises, time = null, createdBy = 'manual', condition = null } = {}) {
    const data = Store.get();
    data.schedule = {
      exercises: Array.isArray(exercises) ? exercises.filter(Boolean) : [],
      time: time || null,
      createdBy,
      condition: condition || null,
      updatedAt: new Date().toISOString(),
    };
    Store.save(data);
    return data.schedule;
  },

  addScheduleExercise(exerciseId) {
    const data = Store.get();
    if (!data.schedule) data.schedule = { exercises: [], time: null, createdBy: 'manual', condition: null, updatedAt: new Date().toISOString() };
    data.schedule.exercises.push(exerciseId);
    data.schedule.updatedAt = new Date().toISOString();
    Store.save(data);
    return data.schedule;
  },

  removeScheduleExercise(index) {
    const data = Store.get();
    if (!data.schedule || !Array.isArray(data.schedule.exercises)) return null;
    data.schedule.exercises.splice(index, 1);
    data.schedule.updatedAt = new Date().toISOString();
    Store.save(data);
    return data.schedule;
  },

  setScheduleTime(time) {
    const data = Store.get();
    if (!data.schedule) data.schedule = { exercises: [], time: null, createdBy: 'manual', condition: null, updatedAt: new Date().toISOString() };
    data.schedule.time = time || null;
    data.schedule.updatedAt = new Date().toISOString();
    Store.save(data);
    return data.schedule;
  },

  clearSchedule() {
    const data = Store.get();
    data.schedule = null;
    Store.save(data);
  },

  scheduleTotalMinutes() {
    const s = Store.get().schedule;
    if (!s || !Array.isArray(s.exercises)) return 0;
    return s.exercises.reduce((sum, id) => {
      const e = findExercise(id);
      return sum + (e ? e.duration : 0);
    }, 0);
  },

  // Marks `date` complete for the active plan if `exercise` is one of its
  // prescribed exercises and that date isn't already logged, then
  // recomputes the plan's own consecutive-day streak. Completing the
  // prescribed number of days marks the plan inactive (done).
  _progressRecoveryPlan(data, exercise, date) {
    const plan = data.recoveryPlan;
    if (!plan || !plan.active || !plan.exerciseIds.includes(exercise)) return;
    if (!plan.completedDates.includes(date)) plan.completedDates.push(date);
    plan.streak = Store._computeStreak(
      Object.fromEntries(plan.completedDates.map((d) => [d, 1]))
    );
    plan.bestStreak = Math.max(plan.bestStreak || 0, plan.streak);
    if (plan.completedDates.length >= plan.totalDays) plan.active = false;
  },

  _computeStreak(calendarDays) {
    let streak = 0;
    let cursor = 0;
    // allow "today" to not break the streak even if no session logged yet today
    if (!calendarDays[todayISO(0)]) cursor = -1;
    while (calendarDays[todayISO(cursor)]) {
      streak++;
      cursor--;
    }
    return streak;
  },

  // ----- derived stats used across Dashboard / Progress -----
  todayMinutes() {
    const data = Store.get();
    return Math.round((data.calendarDays[todayISO()] || 0) * 10) / 10;
  },
  todayCalories() {
    const data = Store.get();
    return data.sessions
      .filter((s) => s.date === todayISO())
      .reduce((sum, s) => sum + s.calories, 0);
  },
  overallAvgForm() {
    const data = Store.get();
    if (!data.sessions.length) return 0; // true zero state until a session is actually recorded
    const sum = data.sessions.reduce((s, x) => s + x.avgForm, 0);
    return Math.round(sum / data.sessions.length);
  },
  weekMinutes() {
    const data = Store.get();
    let total = 0;
    for (let i = 0; i < 7; i++) total += data.calendarDays[todayISO(-i)] || 0;
    return Math.round(total);
  },
  weeklyBars() {
    // last 7 days, oldest -> newest, minutes scaled to a 0-100 bar height
    const data = Store.get();
    const raw = [];
    for (let i = 6; i >= 0; i--) raw.push(data.calendarDays[todayISO(-i)] || 0);
    const max = Math.max(...raw, 20);
    return raw.map((m) => Math.max(6, Math.round((m / max) * 100)));
  },
  monthlyBars() {
    const data = Store.get();
    const weeks = [0, 0, 0, 0];
    for (let i = 0; i < 28; i++) {
      const mins = data.calendarDays[todayISO(-i)] || 0;
      weeks[3 - Math.floor(i / 7)] += mins;
    }
    const max = Math.max(...weeks, 20);
    return weeks.map((m) => Math.max(6, Math.round((m / max) * 100)));
  },
  consistencyScore() {
    const data = Store.get();
    let active = 0;
    for (let i = 0; i < 30; i++) if (data.calendarDays[todayISO(-i)]) active++;
    return Math.round((active / 30) * 100);
  },
  totalSessions() {
    return Store.get().sessions.length;
  },
  // ----- preferred language (Profile → Preferred Language) -----
  // Signed-in: stored on the account's own data record, saved/synced via the
  // existing Store.save() -> CloudSync path like everything else here.
  // Signed-out: falls back to a small localStorage key so the choice still
  // survives refresh/navigation until the person signs in.
  getPreferredLanguage() {
    return Store.get().preferredLanguage || DEFAULT_LANGUAGE;
  },
  setPreferredLanguage(code) {
    const lang = isSupportedLanguage(code) ? code : DEFAULT_LANGUAGE;
    if (!Auth.isLoggedIn()) {
      writeJSON(GUEST_LANGUAGE_KEY, lang);
      return lang;
    }
    const data = Store.get();
    data.preferredLanguage = lang;
    Store.save(data);
    return lang;
  },

  // ----- profile demographics -----
  getProfileDetails() {
    const data = Store.get();
    return { ageGroup: data.ageGroup || '', gender: data.gender || '', preferredLanguage: data.preferredLanguage || DEFAULT_LANGUAGE };
  },
  setProfileDetails({ ageGroup, gender, preferredLanguage } = {}) {
    const data = Store.get();
    if (ageGroup !== undefined) data.ageGroup = ageGroup;
    if (gender !== undefined) data.gender = gender;
    if (preferredLanguage !== undefined) data.preferredLanguage = isSupportedLanguage(preferredLanguage) ? preferredLanguage : DEFAULT_LANGUAGE;
    Store.save(data);
    return data;
  },

  achievements() {
    const data = Store.get();
    const avgForm = Store.overallAvgForm();
    const mobilityDone = data.sessions.some((s) => s.exercise === 'cat-cow' || s.exercise === 'hip-flexor');
    return [
      { icon: '🏆', label: 'Form Master', unlocked: avgForm >= 90 && data.sessions.length > 0 },
      { icon: '✨', label: 'Consistency Starter', unlocked: data.stats.streak >= 3 },
      { icon: '🌱', label: 'Mobility Explorer', unlocked: mobilityDone },
      { icon: '🔥', label: '7-Day Streak', unlocked: data.stats.streak >= 7 },
      { icon: '💯', label: '10 Sessions Logged', unlocked: data.sessions.length >= 10 },
    ];
  },
};

export { todayISO };
