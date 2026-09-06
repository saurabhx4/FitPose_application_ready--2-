// FitPose AI chat — dedicated ONLY to exercise and physiotherapy topics.
//
// Two tiers, tried in order (see getCoachReply(), called from app.js):
//  1. Real AI Coach — POST /api/coach on the Flask backend (backend/ai_coach.py),
//     which calls OpenAI with a system prompt that keeps it acting ONLY as an
//     in-app physiotherapist assistant. It asks how long a reported problem
//     (e.g. "neck pain") has been going on, then schedules real exercises
//     from EXERCISES for a number of days — see Store.startRecoveryPlan().
//     Only active when VITE_API_BASE_URL is set AND the backend has a real
//     OPENAI_API_KEY configured (backend/.env.example).
//  2. On-device fallback — the small ML intent classifier below
//     (physioML.js — TF-IDF + cosine similarity, no network call), answered
//     with fixed rules + the person's own stored session data. Used
//     automatically whenever tier 1 isn't configured or a request fails, so
//     the chat always works with zero setup.
import { Auth, Store } from './store.js';
import { EXERCISES, findExercise } from './exercises.js';
import { classifyIntent, detectBodyPart } from './physioML.js';
import { getLanguage } from './i18n/i18n.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';

export function isAICoachConfigured() {
  return !!API_BASE;
}

/**
 * Calls the real OpenAI-backed AI Coach on the backend. `history` is the
 * full conversation so far as [{role: 'user'|'assistant', content}, ...]
 * (most recent message last). Returns {reply, plan, askedFollowUp} on
 * success, or null if the AI coach isn't configured/reachable — callers
 * should fall back to `coachReply()` below in that case.
 */
export async function getAICoachReply(history) {
  if (!API_BASE) return null;

  try {
    const user = Auth.currentUser();
    const data = Store.get();

    const fitposeContext = {
      stats: {
        streak: Number(data?.stats?.streak || 0),
        bestStreak: Number(data?.stats?.bestStreak || 0),
        sessions: Array.isArray(data?.sessions) ? data.sessions.slice(0, 10).map((x) => ({
          date: x.date,
          exerciseLabel: x.exerciseLabel,
          avgForm: x.avgForm,
          reps: x.reps,
          durationSec: x.durationSec,
        })) : [],
      },
      recoveryPlan: data?.recoveryPlan ? {
        condition: data.recoveryPlan.condition,
        exerciseIds: data.recoveryPlan.exerciseIds,
        totalDays: data.recoveryPlan.totalDays,
        active: data.recoveryPlan.active,
        completedDays: Array.isArray(data.recoveryPlan.completedDates) ? data.recoveryPlan.completedDates.length : 0,
      } : null,
    };

    const res = await fetch(`${API_BASE.replace(/\/$/, '')}/api/coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        exercises: EXERCISES.map((e) => ({
          id: e.id,
          name: e.name,
          target: e.target,
          category: e.category,
          difficulty: e.difficulty,
          duration: e.duration,
        })),
        profile: {
          gender: user?.gender || null,
          ageGroup: user?.ageGroup || null,
          fitposeContext,
          // The user's Profile → Preferred Language selection. This is the
          // ONLY multilingual addition to the existing AI Coach request —
          // everything else about this call (endpoint, messages, exercises,
          // response shape) is unchanged. See backend/ai_coach.py, which
          // uses this purely to tell the existing OpenAI request which
          // language to reply in.
          language: getLanguage(),
        },
      }),
      signal: AbortSignal.timeout(50000),
    });

    let payload = null;
    try { payload = await res.json(); } catch {}

    if (!res.ok) {
      console.error('[FitPose AI] backend error:', res.status, payload);
      if (payload?.error) {
        return { error: String(payload.error), code: payload.code || null };
      }
      return null;
    }

    if (!payload || typeof payload.reply !== 'string') return null;
    return payload;
  } catch (error) {
    console.error('[FitPose AI] request failed:', error);
    return null;
  }
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const SEE_A_PRO = "If it's severe, doesn't ease up after a few days of gentle movement, or comes with numbness, tingling, or swelling, please check in with a doctor or physiotherapist rather than pushing through it.";

function exerciseLine(id) {
  const e = findExercise(id);
  return `${e.name} (${e.duration} min) — ${e.steps[0]}`;
}

function neckPainReply() {
  return `For neck tension, gentle mobility usually helps more than stretching hard: try the ${exerciseLine('neck-stretch')} Keep movements slow, breathe steadily, and stop if anything sharp comes on. Also worth checking: is your screen at eye height, and are your shoulders relaxed while you work? ${SEE_A_PRO}`;
}

function backPainReply() {
  return `For lower or upper back tightness, easy mobility work is usually the safest starting point: try ${exerciseLine('cat-cow')} You could follow it with a ${exerciseLine('hip-flexor')} since tight hips often pull on the lower back. Avoid heavy lifting or deep squats until it settles. ${SEE_A_PRO}`;
}

function jointPainReply(userText) {
  const part = detectBodyPart(userText);
  if (part === 'shoulder') {
    return `For shoulder discomfort, keep movements small and pain-free: try the ${exerciseLine('shoulder-raise')} Avoid raising through any sharp pain — dull, mild effort is fine. ${SEE_A_PRO}`;
  }
  if (part === 'hip' || part === 'knee' || part === 'ankle') {
    return `For ${part} discomfort, gentle rotation work can help maintain mobility without loading the joint hard: try the ${exerciseLine('hip-rotation')} Skip squats or anything with impact until it feels better, and ice + rest works well for a fresh, acute strain. ${SEE_A_PRO}`;
  }
  return `For general joint aches, start with gentle range-of-motion work rather than strength training — the ${exerciseLine('hip-rotation')} or ${exerciseLine('cat-cow')} are good low-load options. If one specific joint is swollen, hot, or was hurt in an injury, rest it and get it checked rather than exercising through it. ${SEE_A_PRO}`;
}

function postureCheckReply() {
  const data = Store.get();
  const lastSession = data.sessions[0];
  return lastSession
    ? `Your last session (${lastSession.exerciseLabel}) averaged ${lastSession.avgForm}% form. ${
        lastSession.avgForm >= 85
          ? "That's strong — keep your chest open and shoulders relaxed to hold onto it."
          : 'Try slowing the movement down and keeping your torso upright; that alone tends to lift form scores fast.'
      }`
    : "You haven't logged a live session yet, so I can't check your real posture data — head to Workout and start a live session, and I'll read your form in real time.";
}

function routineReply(userText) {
  if (/10.?min/.test(userText)) {
    return 'Try this 10-minute set: Cat-Cow Stretch (3 min) → Bodyweight Squat (5 min) → Neck Stretch (2 min). Head to Exercises to launch any of these with live AI feedback.';
  }
  const picks = [EXERCISES[1], EXERCISES[3], EXERCISES[0]];
  return `Here's a quick routine: ${picks.map((p) => `${p.name} (${p.duration} min)`).join(', then ')}. That's about ${picks.reduce((s, p) => s + p.duration, 0)} minutes total — open the Exercise Library and tap "Start AI" on each.`;
}

function motivationReply() {
  const data = Store.get();
  const streak = data.stats.streak;
  return streak > 0
    ? `You're on a ${streak}-day streak 🔥 — even a 5-minute mobility session today keeps it alive.`
    : 'No active streak yet — start one today with a short session, even 5 minutes counts.';
}

function generalExerciseReply(userText) {
  const match = EXERCISES.find((e) => userText.includes(e.id.replace('-', ' ')) || userText.includes(e.name.toLowerCase()));
  if (match) {
    return `${match.name}: ${match.steps.join(' ')} Start a live session and I'll count reps and flag form issues automatically.`;
  }
  if (/calor/.test(userText)) {
    return `You've logged about ${Store.todayCalories()} calories today. Longer, higher-rep sessions like squats or push-ups burn more than static holds like plank.`;
  }
  if (/(how am i doing|progress|how.*i.*doing)/.test(userText)) {
    const avgForm = Store.overallAvgForm();
    const data = Store.get();
    return `Your overall form average is ${avgForm}%, streak is ${data.stats.streak} day(s), and you've logged ${data.sessions.length} session(s) so far. Check the Dashboard tab for the full picture.`;
  }
  return 'For squats: feet shoulder-width, knees tracking over toes, chest lifted, and aim for a ~90° knee bend at the bottom. For plank: a straight line from shoulders to heels, core braced, neck neutral. Start a live session and I\'ll flag alignment issues automatically — or ask me about a specific exercise.';
}

const OFF_TOPIC_LINES = [
  "I'm FitPose AI, and I only cover exercise and physiotherapy — things like posture, pain relief stretches, or workout plans. What can I help you with there?",
  "That's outside what I help with — I'm focused on exercise and physiotherapy. Ask me about a routine, form, or a pain point and I'll dig in.",
];

export function coachReply(userText) {
  const text = userText.toLowerCase();
  const { intent } = classifyIntent(text);

  switch (intent) {
    case 'neck_pain':
      return neckPainReply();
    case 'back_pain':
      return backPainReply();
    case 'joint_pain':
      return jointPainReply(text);
    case 'posture_check':
      return postureCheckReply();
    case 'routine_request':
      return routineReply(text);
    case 'motivation':
      return motivationReply();
    case 'general_exercise':
      return generalExerciseReply(text);
    case 'greeting':
      return 'Hey! Good to see you. Want a posture check, a new routine, or help with a pain point like neck or back tension?';
    case 'thanks':
      return "Anytime! I'm always here when you need a form check, a plan, or pain-relief guidance. 🌿";
    case 'off_topic':
    default:
      return pick(OFF_TOPIC_LINES);
  }
}
