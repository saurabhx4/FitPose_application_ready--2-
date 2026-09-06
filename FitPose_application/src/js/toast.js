export function toast(message, type = '') {
  let wrap = document.getElementById('toastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toastWrap';
    wrap.className = 'toastWrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
