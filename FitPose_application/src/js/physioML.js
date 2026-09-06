// ===== On-device ML intent classifier for the FitPose AI chat =====
// A small TF-IDF + cosine-similarity (1-nearest-neighbor) text classifier,
// trained on hand-labeled example phrases below. It runs entirely in the
// browser — no network call, no API key — matching the rest of FitPose's
// on-device/nothing-uploaded design. This is a real (if small) supervised
// ML model: training examples are vectorized with TF-IDF, and a new message
// is classified by finding the labeled example it's closest to in that
// vector space. The chat this powers is scoped ONLY to exercise and
// physiotherapy topics — anything outside that domain is routed to the
// `off_topic` intent instead of being answered.

// ---- Training data: labeled example utterances per intent ----
const TRAINING_DATA = [
  // Neck pain / stiffness
  ['my neck hurts', 'neck_pain'],
  ['I have neck pain after sitting at my desk', 'neck_pain'],
  ['my neck is really stiff', 'neck_pain'],
  ['sharp pain when I turn my head', 'neck_pain'],
  ['tension in my neck and shoulders', 'neck_pain'],
  ['neck ache from working on my laptop', 'neck_pain'],
  ['my neck feels sore and tight', 'neck_pain'],
  ['pain at the back of my neck', 'neck_pain'],
  ['stiff neck when I wake up', 'neck_pain'],
  ['how do I relieve neck tension', 'neck_pain'],

  // Back pain
  ['my lower back hurts', 'back_pain'],
  ['I have back pain', 'back_pain'],
  ['my back is so stiff today', 'back_pain'],
  ['pain in my spine when I bend over', 'back_pain'],
  ['upper back pain from sitting all day', 'back_pain'],
  ['my back hurts after lifting something', 'back_pain'],
  ['sore lower back muscles', 'back_pain'],
  ['my back aches when I stand for a while', 'back_pain'],
  ['I feel a dull ache in my lower back', 'back_pain'],
  ['how can I fix my back pain', 'back_pain'],

  // Joint pain (knee / shoulder / wrist / hip / elbow / ankle)
  ['my knee hurts when I walk', 'joint_pain'],
  ['I have joint pain in my shoulder', 'joint_pain'],
  ['my wrist hurts after typing all day', 'joint_pain'],
  ['my elbow is sore', 'joint_pain'],
  ['hip pain when I walk up stairs', 'joint_pain'],
  ['my ankle feels stiff and achy', 'joint_pain'],
  ['my knees feel stiff in the morning', 'joint_pain'],
  ['my joints ache all over', 'joint_pain'],
  ['shoulder pain when I raise my arm', 'joint_pain'],
  ['my knee feels weak and painful', 'joint_pain'],

  // Posture check (uses live/session data)
  ['check my posture', 'posture_check'],
  ['how is my posture', 'posture_check'],
  ['am I standing correctly', 'posture_check'],
  ['is my form good', 'posture_check'],
  ['give me posture feedback', 'posture_check'],
  ['how was my form in my last session', 'posture_check'],
  ['analyze my posture', 'posture_check'],

  // Routine / workout plan requests
  ['build me a workout', 'routine_request'],
  ['create a workout routine for me', 'routine_request'],
  ['give me a workout plan', 'routine_request'],
  ['suggest some exercises for today', 'routine_request'],
  ['I want a 10 minute routine', 'routine_request'],
  ['plan my workout for me', 'routine_request'],
  ['what should I do for a workout today', 'routine_request'],
  ['recommend a beginner routine', 'routine_request'],

  // Motivation / streaks
  ["I don't feel like working out", 'motivation'],
  ['motivate me to exercise', 'motivation'],
  ["I'm feeling lazy today", 'motivation'],
  ['I lost my streak', 'motivation'],
  ['how am I doing with my streak', 'motivation'],
  ['I keep skipping workouts', 'motivation'],
  ['encourage me to keep going', 'motivation'],

  // General exercise / form knowledge
  ['how do I do a squat correctly', 'general_exercise'],
  ['explain proper plank form', 'general_exercise'],
  ['what are the benefits of push ups', 'general_exercise'],
  ['how many calories does squats burn', 'general_exercise'],
  ['what is a good warm up', 'general_exercise'],
  ['how do I do a push up', 'general_exercise'],
  ['what muscles does plank work', 'general_exercise'],
  ['how many reps of squats should I do', 'general_exercise'],

  // Greetings / thanks
  ['hi', 'greeting'],
  ['hello', 'greeting'],
  ['hey there', 'greeting'],
  ['good morning', 'greeting'],
  ['thank you', 'thanks'],
  ['thanks a lot', 'thanks'],
  ['thanks for the help', 'thanks'],

  // Off-topic (outside exercise/physiotherapy scope)
  ["what's the weather today", 'off_topic'],
  ['who is the president', 'off_topic'],
  ['tell me a joke', 'off_topic'],
  ['what is 2 plus 2', 'off_topic'],
  ['write me a poem', 'off_topic'],
  ['translate this to french', 'off_topic'],
  ['what stocks should I buy', 'off_topic'],
  ['recommend a movie to watch', 'off_topic'],
  ['what is the capital of france', 'off_topic'],
  ['can you help me with my homework', 'off_topic'],
];

// Words that signal a message is at least on-topic (exercise/health domain),
// even if the classifier's best match is a weak one. Keeps the domain gate
// from being purely similarity-based.
const DOMAIN_VOCAB = new Set([
  'pain', 'ache', 'aches', 'aching', 'sore', 'soreness', 'stiff', 'stiffness',
  'hurt', 'hurts', 'injury', 'injured', 'strain', 'sprain', 'tension',
  'neck', 'back', 'spine', 'shoulder', 'shoulders', 'knee', 'knees', 'hip',
  'hips', 'wrist', 'elbow', 'ankle', 'joint', 'joints', 'muscle', 'muscles',
  'posture', 'form', 'exercise', 'exercises', 'workout', 'routine', 'reps',
  'rep', 'squat', 'squats', 'plank', 'pushup', 'push-up', 'stretch',
  'stretches', 'stretching', 'mobility', 'flexibility', 'physio',
  'physiotherapy', 'physical', 'therapy', 'session', 'streak', 'calories',
  'fitness', 'movement', 'stand', 'standing', 'sitting', 'desk', 'warmup',
  'warm-up', 'cooldown', 'recovery', 'core', 'glutes', 'chest', 'arms',
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// ---- Build TF-IDF vectors for the training corpus once, at module load ----
const vocabulary = new Map(); // term -> index
const docTokens = TRAINING_DATA.map(([text]) => tokenize(text));
docTokens.forEach((tokens) => {
  new Set(tokens).forEach((term) => {
    if (!vocabulary.has(term)) vocabulary.set(term, vocabulary.size);
  });
});

const idf = new Float64Array(vocabulary.size);
{
  const docCount = docTokens.length;
  const containing = new Float64Array(vocabulary.size);
  docTokens.forEach((tokens) => {
    new Set(tokens).forEach((term) => {
      containing[vocabulary.get(term)] += 1;
    });
  });
  for (let i = 0; i < idf.length; i++) {
    idf[i] = Math.log((1 + docCount) / (1 + containing[i])) + 1;
  }
}

function vectorize(tokens) {
  const vec = new Float64Array(vocabulary.size);
  const counts = new Map();
  tokens.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
  counts.forEach((count, term) => {
    const idx = vocabulary.get(term);
    if (idx === undefined) return; // unseen word — ignored (standard for a fixed-vocab model)
    const tf = count / tokens.length;
    vec[idx] = tf * idf[idx];
  });
  return vec;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const trainingVectors = docTokens.map(vectorize);

/**
 * Classify a chat message into one of the intents above using 1-NN over
 * TF-IDF vectors. Returns { intent, confidence } where confidence is the
 * cosine similarity (0..1) to the closest training example.
 */
export function classifyIntent(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return { intent: 'off_topic', confidence: 0 };

  const queryVec = vectorize(tokens);
  let best = { intent: 'off_topic', confidence: 0 };
  trainingVectors.forEach((vec, i) => {
    const sim = cosineSim(queryVec, vec);
    if (sim > best.confidence) {
      best = { intent: TRAINING_DATA[i][1], confidence: sim };
    }
  });

  const onDomain = tokens.some((t) => DOMAIN_VOCAB.has(t));
  // Low-confidence matches that don't touch the fitness/physio vocabulary at
  // all are treated as out of scope, even if 1-NN found *some* closest label.
  if (best.confidence < 0.32 && !onDomain) {
    return { intent: 'off_topic', confidence: best.confidence };
  }
  return best;
}

/** Very light body-part detector, used to tailor joint-pain suggestions. */
export function detectBodyPart(text) {
  const lower = String(text).toLowerCase();
  const parts = ['knee', 'shoulder', 'wrist', 'elbow', 'hip', 'ankle'];
  return parts.find((p) => lower.includes(p)) || null;
}
