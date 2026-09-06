// ===== Assistant Voice: microphone input + spoken AI Coach replies =====
// Pipeline: microphone (this file) -> POST /api/voice/transcribe (STT) ->
// the transcript is handed to app.js's existing sendMessage(), which runs
// it through the SAME existing OpenAI AI Coach used for typed messages ->
// the reply text is handed back here -> POST /api/voice/speak (TTS) ->
// browser plays the audio. This file only does recording + the two network
// calls; it has no chatbot logic of its own and never talks to /api/coach
// directly.
//
// Reuses the same VITE_API_BASE_URL as coach.js — no separate configuration.
const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';

export function isVoiceInputConfigured() {
  return !!API_BASE;
}

export function isMicSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export class MicPermissionError extends Error {}
export class NoSpeechError extends Error {}

// Detect the browser's supported recording MIME type rather than assuming
// one — Chrome/Firefox/Safari don't all support the same audio codecs.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];
function pickSupportedMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return MIME_CANDIDATES.find((type) => {
    try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
  }) || '';
}

const EXT_BY_MIME = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/wav': 'wav' };
function extensionFor(mimeType) {
  const base = (mimeType || '').split(';')[0].trim();
  return EXT_BY_MIME[base] || 'webm';
}

let active = null; // { recorder, stream, chunks, mimeType }

export function isRecording() {
  return !!active && active.recorder.state === 'recording';
}

/** Request mic permission and start recording. Throws MicPermissionError if denied. */
export async function startRecording() {
  if (active) return; // already recording — ignore duplicate starts
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new MicPermissionError('Microphone access is required for voice input.');
  }
  const mimeType = pickSupportedMimeType();
  let recorder;
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    recorder = new MediaRecorder(stream); // last-resort: let the browser pick
  }
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  active = { recorder, stream, chunks, mimeType: recorder.mimeType || mimeType };
  recorder.start();
}

/** Release the microphone without submitting anything (e.g. navigating away mid-recording). */
export function cancelRecording() {
  if (!active) return;
  const { recorder, stream } = active;
  try {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
  } catch { /* ignore */ }
  stream.getTracks().forEach((track) => track.stop());
  active = null;
}

/** Stop recording and resolve with the captured audio. Throws NoSpeechError if nothing was captured. */
export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!active) { reject(new Error('Not recording.')); return; }
    const { recorder, stream, chunks, mimeType } = active;
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      active = null;
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      if (!blob.size) {
        reject(new NoSpeechError("I didn't hear anything. Please try again."));
        return;
      }
      resolve({ blob, mimeType: mimeType || blob.type || 'audio/webm' });
    };
    try {
      recorder.stop();
    } catch (ex) {
      reject(ex);
    }
  });
}

/**
 * Send recorded audio to the backend for multilingual speech-to-text.
 * `language` is an optional ISO-639-1 hint (the app's current FitPose
 * language) — the backend auto-detects when it's omitted or unrecognized,
 * which is what lets this support languages FitPose's UI doesn't even list
 * yet (Spanish, French, German, Japanese, ...).
 */
export async function transcribeAudio(blob, mimeType, language) {
  const form = new FormData();
  form.append('audio', blob, `voice-input.${extensionFor(mimeType)}`);
  if (language) form.append('language', language);

  let res;
  try {
    res = await fetch(`${API_BASE.replace(/\/$/, '')}/api/voice/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new Error("I couldn't reach the FitPose backend. Please check your connection and try again.");
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error body */ }

  if (res.status === 422 || payload?.error === 'no_speech') {
    throw new NoSpeechError(payload?.message || "I didn't hear anything. Please try again.");
  }
  if (!res.ok) {
    throw new Error(payload?.message || "I couldn't understand the audio. Please try again.");
  }

  const transcript = (payload?.transcript || '').trim();
  if (!transcript) {
    throw new NoSpeechError("I didn't hear anything. Please try again.");
  }
  return transcript;
}

/**
 * Send the existing AI Coach's reply text to the backend for multilingual
 * text-to-speech and play the resulting audio. Resolves (never rejects) once
 * playback has finished or failed — a TTS problem must never surface as a
 * chat error, since the reply is already shown as text before this runs.
 */
export async function speakText(text) {
  const clean = String(text || '').trim();
  if (!clean) return;

  let res;
  try {
    res = await fetch(`${API_BASE.replace(/\/$/, '')}/api/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    return; // network failure — swallow, chat already has the text reply
  }
  if (!res.ok) return;

  let audioBlob;
  try {
    audioBlob = await res.blob();
  } catch {
    return;
  }

  const url = URL.createObjectURL(audioBlob);
  const audio = new Audio(url);
  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
  URL.revokeObjectURL(url);
}
