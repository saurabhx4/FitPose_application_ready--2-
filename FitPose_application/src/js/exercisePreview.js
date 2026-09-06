// ===== Exercise Preview modal =====
// Shows a real looping video (or GIF) demonstrating the selected exercise in a
// frame beside a numbered how-to list. Each exercise's `media` field (see
// exercises.js) points at the clip to play — no CSS-animated stand-in figure.
let activeExercise = null;

export function openPreview(exercise) {
  if (!exercise) return;
  activeExercise = exercise;
  const modal = document.getElementById('previewModal');
  if (!modal) return;

  document.getElementById('previewTitle').textContent = exercise.code ? `${exercise.code} · ${exercise.name}` : exercise.name;
  document.getElementById('previewChip').textContent = `${exercise.category} · ${exercise.difficulty}`;
  document.getElementById('previewDesc').textContent = `${exercise.desc} · about ${exercise.duration} min`;
  document.getElementById('previewStepsList').innerHTML = (exercise.steps || [])
    .map((s) => `<li>${s}</li>`)
    .join('');

  const video = document.getElementById('previewVideo');
  const gif = document.getElementById('previewGif');
  const placeholder = document.getElementById('previewMediaPlaceholder');
  const media = exercise.media;

  if (media?.type === 'gif' || media?.type === 'image') {
    placeholder?.style.setProperty('display', 'none');
    video.pause();
    video.removeAttribute('src');
    video.style.display = 'none';
    gif.src = media.src;
    gif.alt = `${exercise.name} demonstration`;
    gif.style.display = '';
  } else if (media?.src) {
    placeholder?.style.setProperty('display', 'none');
    gif.style.display = 'none';
    gif.removeAttribute('src');
    video.style.display = '';
    video.src = media.src;
    video.currentTime = 0;
    video.play().catch(() => {}); // autoplay can be blocked before a user gesture; ignore
  } else {
    video.style.display = 'none';
    gif.style.display = 'none';
    placeholder?.style.setProperty('display', 'grid');
  }

  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

export function closePreview() {
  const modal = document.getElementById('previewModal');
  if (!modal) return;
  modal.classList.remove('show');
  document.body.style.overflow = '';
  const video = document.getElementById('previewVideo');
  if (video) video.pause();
}

export function activePreviewExercise() {
  return activeExercise;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePreview();
});
