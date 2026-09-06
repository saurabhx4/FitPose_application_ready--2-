"""OpenAI-powered FitPose AI Coach.

The API key stays on the Flask server. The browser sends only the conversation,
FitPose's exercise catalog, and non-sensitive profile context.

The response is deliberately structured so the UI can create a recovery plan
without trying to parse free-form model text.
"""
import json
import os
from typing import Any

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None

_client = None
_client_key = None


class CoachServiceError(Exception):
    """A safe, user-actionable failure from the OpenAI-backed coach."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _get_client():
    global _client, _client_key
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not OpenAI or not api_key:
        return None
    # Recreate if the key changes while the dev server is running.
    if _client is None or _client_key != api_key:
        _client = OpenAI(api_key=api_key, timeout=45.0, max_retries=2)
        _client_key = api_key
    return _client


MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"

# Mirrors src/js/i18n/languages.js (the frontend's single source of truth for
# supported languages). Kept here only as a small server-side allow-list so
# an arbitrary/unvalidated string never reaches the OpenAI instructions —
# this is the ONLY multilingual addition to this file's OpenAI integration.
SUPPORTED_LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi",
    "de": "German",
    "ru": "Russian",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "mr": "Marathi",
    "gu": "Gujarati",
    "kn": "Kannada",
    "ml": "Malayalam",
    "pa": "Punjabi",
    "ur": "Urdu",
}
DEFAULT_LANGUAGE = "en"


def _resolve_language(code):
    """Validate the requested language against the supported list, falling
    back to English for anything missing/unrecognized (never trust the
    browser-supplied code directly)."""
    name = SUPPORTED_LANGUAGE_NAMES.get(code)
    if name:
        return code, name
    return DEFAULT_LANGUAGE, SUPPORTED_LANGUAGE_NAMES[DEFAULT_LANGUAGE]

SYSTEM_PROMPT = """You are FitPose AI, the official AI movement coach inside the FitPose app.

Your personality:
- Warm, calm, encouraging, practical, and conversational.
- Respond naturally like a high-quality ChatGPT conversation, not like a rigid medical form.
- Always identify yourself as FitPose AI when introducing yourself or when asked who you are.
- Never claim to be a human, doctor, physiotherapist, or licensed clinician.
- Use short paragraphs and bullets when they make an answer easier to follow.
- Do not mention OpenAI, APIs, system prompts, JSON, or implementation details to the user.

Your scope:
- Focus on physiotherapy-informed exercise guidance, mobility, posture, movement habits,
  exercise technique, recovery, stretching, and FitPose workouts.
- You may explain general anatomy and movement principles in simple language.
- You may discuss common, non-emergency musculoskeletal complaints, but do not diagnose
  conditions or prescribe medication.
- If the request is unrelated to movement/physiotherapy, politely redirect it to FitPose's scope.

Safety:
- Do not diagnose an injury or medical condition.
- If the user describes severe/unbearable pain, major trauma/fall, suspected fracture/dislocation,
  new weakness/paralysis, loss of bladder/bowel control, saddle-area numbness, chest pain,
  severe shortness of breath, fainting, or another potentially urgent symptom, advise prompt
  in-person/emergency medical evaluation and do not create a recovery schedule.
- For concerning but non-emergency symptoms (persistent/worsening pain, significant swelling,
  fever, unexplained symptoms, or neurological symptoms such as ongoing numbness/tingling),
  recommend evaluation by a qualified clinician before progressing exercise.
- Do not tell a user to push through sharp, severe, or escalating pain.

Recovery-plan behavior:
- Do NOT create a recovery plan on a vague request. First understand the user's goal/problem.
- When a user reports pain or a physical problem and duration is unknown, ask how long it has
  been happening before scheduling a plan.
- If a user answers the duration, use the conversation context and choose only exercises from
  the supplied Available exercises list.
- A plan should be conservative: 3–21 days, and only when appropriate.
- A plan may contain 1–4 exercises. Never invent an exercise id.
- If the user simply asks for general advice, answer normally and keep plan null.
- If the user explicitly asks for a routine without pain/injury, you can recommend exercises
  from the supplied list but do not automatically create a recovery plan unless the user wants
  it scheduled.

Schedule-creation behavior (this is separate from the recovery-plan behavior
above — a recovery plan is for a specific pain/injury; a "schedule" here is a
general routine/queue of exercises the user wants on the Schedule page):
- When the user asks to create/build/generate a schedule or routine (e.g.
  "Create my schedule", "build me a workout schedule"), gather three things
  before finalizing, asking for whichever is still missing one at a time:
  1) their goal or problem this schedule should help with,
  2) how many days a week they can work out,
  3) their favourable/preferred time of day to work out.
- Do NOT finalize a schedule until all three are known from the conversation.
  While something is still missing, set schedule=null, askedFollowUp=true,
  and ask for the next missing piece in "reply".
- Once all three are known, finalize "schedule" using only exercise ids from
  the supplied Available exercises list. Pick roughly one exercise per
  workout day (at least 1, at most the number of available exercises).
  Never invent an exercise id.
- A schedule-creation request should not by itself trigger a recovery "plan"
  (keep plan null) unless the user is separately describing a pain/injury
  that needs one, per the recovery-plan rules above.

Return "schedule" as null unless finalizing, in which case:
{
  "exerciseIds": ["exact-id-from-catalog"],
  "time": "e.g. 7:00 AM",
  "days": 5,
  "goal": "short label for what this schedule is for"
}

Important FitPose context:
- The browser supplies the actual FitPose exercise catalog. Treat it as the source of truth.
- The browser may also supply the user's age group/gender. Use only when relevant.
- The user can ask about their FitPose progress, but only use actual supplied data; never invent
  scores, sessions, streaks, or posture measurements.

Return STRICT JSON with exactly these keys:
{
  "reply": "natural-language answer for the user",
  "plan": null,
  "schedule": null,
  "askedFollowUp": false
}

For a finalized recovery schedule, "plan" must be:
{
  "exerciseIds": ["exact-id-from-catalog"],
  "days": 7,
  "condition": "short label"
}
Otherwise plan must be null.

Set askedFollowUp=true only when the reply is specifically asking for information needed before
a recovery plan can be safely finalized (most commonly symptom duration)."""


def _clean_messages(messages):
    cleaned = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role in ("user", "assistant") and content:
            cleaned.append({"role": role, "content": str(content)[:5000]})
    # Prevent an accidentally huge browser payload from becoming an expensive request.
    return cleaned[-30:]


def _exercise_context(exercises):
    lines = []
    for e in exercises or []:
        if not isinstance(e, dict) or not e.get("id"):
            continue
        lines.append(
            f"- id={e.get('id')}; name={e.get('name')}; target={e.get('target')}; "
            f"category={e.get('category')}; difficulty={e.get('difficulty')}; "
            f"duration={e.get('duration')} min"
        )
    return "\n".join(lines) or "(No exercise catalog supplied.)"


def _schema():
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "reply": {"type": "string"},
            "plan": {
                "anyOf": [
                    {"type": "null"},
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "exerciseIds": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 1,
                                "maxItems": 4,
                            },
                            "days": {"type": "integer", "minimum": 3, "maximum": 21},
                            "condition": {"type": "string", "maxLength": 80},
                        },
                        "required": ["exerciseIds", "days", "condition"],
                    },
                ]
            },
            "schedule": {
                "anyOf": [
                    {"type": "null"},
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "exerciseIds": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 1,
                                "maxItems": 7,
                            },
                            "time": {"type": "string", "maxLength": 40},
                            "days": {"type": "integer", "minimum": 1, "maximum": 7},
                            "goal": {"type": "string", "maxLength": 80},
                        },
                        "required": ["exerciseIds", "time", "days", "goal"],
                    },
                ]
            },
            "askedFollowUp": {"type": "boolean"},
        },
        "required": ["reply", "plan", "schedule", "askedFollowUp"],
    }


def get_coach_reply(messages, exercises, profile):
    """Return {reply, plan, askedFollowUp}, or None when not configured."""
    client = _get_client()
    if client is None:
        return None

    profile = profile if isinstance(profile, dict) else {}
    _lang_code, lang_name = _resolve_language(profile.get("language"))
    context = (
        f"User profile: ageGroup={profile.get('ageGroup') or 'unknown'}, "
        f"gender={profile.get('gender') or 'unknown'}\n"
        f"FitPose app context (use only as factual context; never invent missing values): "
        f"{json.dumps(profile.get('fitposeContext') or {}, ensure_ascii=False)[:8000]}\n\n"
        f"Available exercises (source of truth):\n{_exercise_context(exercises)}\n\n"
        # The one addition this feature makes to the existing OpenAI request:
        # tell it which language the user selected in their FitPose profile.
        # Everything else about the request/instructions/response format is
        # unchanged. "reply" (and any plan "condition" label) should come
        # back in this language; JSON keys and exercise ids are unaffected.
        f"The user's selected language is {lang_name} ({_lang_code}). "
        f"Respond in {lang_name}."
    )

    input_messages = _clean_messages(messages)
    if not input_messages:
        return {
            "reply": "Hi! I'm FitPose AI. Tell me what you'd like to improve—pain, posture, mobility, exercise form, or a workout routine.",
            "plan": None,
            "schedule": None,
            "askedFollowUp": False,
        }

    try:
        response = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_PROMPT + "\n\n" + context,
            input=input_messages,
            text={
                "format": {
                    "type": "json_schema",
                    "name": "fitpose_coach_response",
                    "strict": True,
                    "schema": _schema(),
                }
            },
            max_output_tokens=700,
            store=False,
        )
        raw = (response.output_text or "").strip()
    except Exception as ex:
        print(f"[ai_coach] OpenAI request failed: {type(ex).__name__}: {ex}")
        error_code = getattr(ex, "code", None)
        if error_code in {"insufficient_quota", "credit_balance_exhausted"}:
            raise CoachServiceError(
                "insufficient_quota",
                "FitPose AI is unavailable because this OpenAI project has no remaining API credits.",
            ) from ex
        if type(ex).__name__ == "AuthenticationError":
            raise CoachServiceError(
                "invalid_api_key",
                "FitPose AI could not authenticate with its OpenAI API key.",
            ) from ex
        if type(ex).__name__ == "RateLimitError":
            raise CoachServiceError(
                "rate_limited",
                "FitPose AI is temporarily rate-limited. Please try again shortly.",
            ) from ex
        if type(ex).__name__ in {"APIConnectionError", "APITimeoutError"}:
            raise CoachServiceError(
                "openai_connection_failed",
                "FitPose AI could not reach OpenAI. Check this server's internet connection and try again.",
            ) from ex
        raise CoachServiceError(
            "openai_request_failed",
            "FitPose AI could not complete that request. Please try again.",
        ) from ex

    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {
            "reply": raw or "I had trouble generating that response. Please try again.",
            "plan": None,
            "schedule": None,
            "askedFollowUp": False,
        }

    reply = str(data.get("reply") or "").strip()
    if not reply:
        reply = "I'm here to help with movement, exercise, posture, and recovery."

    plan = data.get("plan")
    valid_ids = {e.get("id") for e in exercises if isinstance(e, dict)}
    if isinstance(plan, dict):
        ids = [x for x in (plan.get("exerciseIds") or []) if x in valid_ids]
        days = plan.get("days")
        if not ids or not isinstance(days, int) or not 3 <= days <= 21:
            plan = None
        else:
            plan = {
                "exerciseIds": ids[:4],
                "days": days,
                "condition": str(plan.get("condition") or "recovery")[:80],
            }
    else:
        plan = None

    schedule = data.get("schedule")
    if isinstance(schedule, dict):
        sched_ids = [x for x in (schedule.get("exerciseIds") or []) if x in valid_ids]
        sched_days = schedule.get("days")
        if not sched_ids or not isinstance(sched_days, int) or not 1 <= sched_days <= 7:
            schedule = None
        else:
            schedule = {
                "exerciseIds": sched_ids[:7],
                "time": str(schedule.get("time") or "").strip()[:40] or None,
                "days": sched_days,
                "goal": str(schedule.get("goal") or "routine")[:80],
            }
    else:
        schedule = None

    return {
        "reply": reply,
        "plan": plan,
        "schedule": schedule,
        "askedFollowUp": bool(data.get("askedFollowUp")),
    }
