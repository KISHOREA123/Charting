import '@fortawesome/fontawesome-free/css/all.min.css';
import { escapeHtml } from './core.js';
let toastTimer;
export function toast(message, kind = 'info') {
  let el = document.getElementById('app-toast');
  if (!el) { el = document.createElement('div'); el.id = 'app-toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.append(el); }
  el.textContent = message; el.className = `toast ${kind}`; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
export function initUI(page) {
  document.body.dataset.page = page;
  document.querySelectorAll('button[title], a[title]').forEach(el => { if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.title); });
  window.addEventListener('storage-error', () => toast('Storage unavailable or full. Export your work before closing this tab.', 'error'));
  document.querySelectorAll('.modal').forEach(modal => {
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const title = modal.querySelector('.modal-title');
    if (title) { title.id ||= modal.id + '-title'; modal.setAttribute('aria-labelledby', title.id); }
    else modal.setAttribute('aria-label', modal.id === 'symbol-modal' ? 'Choose a market' : 'Workspace dialog');
    let opener;
    new MutationObserver(() => {
      if (!modal.classList.contains('hidden')) { opener = document.activeElement; queueMicrotask(() => modal.querySelector('input,select,button,textarea')?.focus()); }
      else if (opener?.isConnected) opener.focus();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); modal.classList.add('hidden'); }
      if (e.key !== 'Tab') return;
      const list = [...modal.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(x => !x.disabled && x.getClientRects().length);
      const first = list[0], last = list.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { document.querySelectorAll('.dropdown-menu.open').forEach(el => el.classList.remove('open')); document.querySelectorAll('[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false')); }
  });
}
export function setBusy(button, busy, label) { button.disabled = busy; button.setAttribute('aria-busy', String(busy)); if (label) button.textContent = label; }
export function showDialog(title, body, onSubmit, { submit = 'Save', destructive = false } = {}) {
  return new Promise(resolve => {
    const d = document.createElement('dialog'); d.className = 'native-dialog';
    d.innerHTML = `<form method="dialog"><header><h2>${escapeHtml(title)}</h2><button type="button" class="dialog-x" aria-label="Close">×</button></header><div class="dialog-body">${body}</div><p class="form-error" role="alert"></p><footer><button value="cancel" class="secondary-btn">Cancel</button><button type="submit" value="save" class="primary-btn ${destructive ? 'danger-btn' : ''}">${escapeHtml(submit)}</button></footer></form>`;
    document.body.append(d);
    d.querySelector('.dialog-x').onclick = () => d.close('cancel');
    d.querySelector('form').addEventListener('submit', async e => {
      if (e.submitter?.value === 'cancel') return;
      e.preventDefault(); const button = e.submitter; if (button) button.disabled = true;
      try { await onSubmit?.(new FormData(e.target), d); d.close('save'); }
      catch (error) { d.querySelector('.form-error').textContent = error.message; }
      finally { if (button) button.disabled = false; }
    });
    d.addEventListener('close', () => { const saved = d.returnValue === 'save'; d.remove(); resolve(saved); }, { once: true });
    d.showModal();
  });
}
