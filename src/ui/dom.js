// Petits utilitaires d'interface.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtInt = (n) => Math.round(n).toLocaleString('fr-FR');
/** Nombre avec virgule décimale (affichage). */
export const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '—');
export const fmtBytes = (n) => (n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} Ko` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${(n / 1024 ** 3).toFixed(2)} Go`);

export function toast(msg, kind = 'info', ms = 4500) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
  while (box.children.length > 5) box.firstChild.remove();
}

export const progress = {
  _cancel: null,
  show(label, onCancel = null) {
    $('#progress').hidden = false;
    $('#progress-label').textContent = label;
    $('#progress-bar').style.width = '0%';
    $('#progress .bar').classList.add('indet');
    this._cancel = onCancel;
    $('#progress-cancel').hidden = !onCancel;
  },
  update(fraction, label) {
    if (label) $('#progress-label').textContent = label;
    if (typeof fraction === 'number' && Number.isFinite(fraction)) {
      $('#progress .bar').classList.remove('indet');
      $('#progress-bar').style.width = `${Math.max(2, Math.min(100, fraction * 100)).toFixed(0)}%`;
    }
  },
  hide() { $('#progress').hidden = true; this._cancel = null; },
};

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export const safeName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'nuage';
