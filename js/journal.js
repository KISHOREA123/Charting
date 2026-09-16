/* ============ ChartPro Trade Journal ============
   CRUD over the RESTful Table API (table: trades). */

(() => {
  'use strict';

  let trades = [];

  async function load() {
    try {
      const res = await fetch('tables/trades?limit=500&sort=-opened_at');
      const d = await res.json();
      trades = d.data || [];
    } catch (e) { trades = []; }
    render();
  }

  function computePnl(t) {
    if (!t.exit || !t.entry || !t.quantity) return null;
    const diff = t.side === 'SHORT' ? t.entry - t.exit : t.exit - t.entry;
    return diff * t.quantity;
  }

  function statusOf(t) {
    if (!t.exit) return 'OPEN';
    const pnl = computePnl(t);
    if (pnl > 0) return 'WIN';
    if (pnl < 0) return 'LOSS';
    return 'BREAKEVEN';
  }

  function render() {
    const tbody = document.getElementById('jr-tbody');
    const closed = trades.filter(t => t.status && t.status !== 'OPEN');
    const wins = closed.filter(t => t.status === 'WIN');
    const losses = closed.filter(t => t.status === 'LOSS');
    const totalPnl = closed.reduce((s, t) => s + (+t.pnl || 0), 0);

    document.getElementById('js-total').textContent = trades.length;
    document.getElementById('js-winrate').textContent =
      closed.length ? (wins.length / closed.length * 100).toFixed(0) + '%' : '—';
    const pnlEl = document.getElementById('js-pnl');
    pnlEl.textContent = closed.length ? (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) : '—';
    pnlEl.className = totalPnl >= 0 ? 'up' : 'down';
    document.getElementById('js-avgwin').textContent =
      wins.length ? '+' + (wins.reduce((s, t) => s + (+t.pnl || 0), 0) / wins.length).toFixed(2) : '—';
    document.getElementById('js-avgloss').textContent =
      losses.length ? (losses.reduce((s, t) => s + (+t.pnl || 0), 0) / losses.length).toFixed(2) : '—';
    document.getElementById('js-open').textContent = trades.filter(t => t.status === 'OPEN').length;

    document.getElementById('jr-empty').classList.toggle('hidden', trades.length > 0);
    tbody.innerHTML = '';
    for (const t of trades) {
      const tr = document.createElement('tr');
      const pnl = +t.pnl || 0;
      const date = t.opened_at ? new Date(t.opened_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—';
      tr.innerHTML = `
        <td>${date}</td>
        <td><b>${esc(t.symbol || '')}</b></td>
        <td><span class="side-badge side-${(t.side || 'LONG').toLowerCase()}">${t.side || 'LONG'}</span></td>
        <td class="num">${fmt(t.entry)}</td>
        <td class="num">${t.exit ? fmt(t.exit) : '—'}</td>
        <td class="num">${t.quantity ?? '—'}</td>
        <td class="num ${pnl >= 0 ? 'up' : 'down'}">${t.status === 'OPEN' ? '—' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2)}</td>
        <td><span class="st-badge st-${(t.status || 'OPEN').toLowerCase()}">${t.status || 'OPEN'}</span></td>
        <td class="notes hide-sm">${esc(t.notes || '')}</td>
        <td>
          ${t.status === 'OPEN' ? '<button class="jr-closebtn" title="Close trade"><i class="fa-solid fa-flag-checkered"></i></button>' : ''}
          <button class="jr-del" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </td>`;
      tr.querySelector('.jr-del').addEventListener('click', async () => {
        if (!confirm(`Delete ${t.symbol} trade?`)) return;
        await fetch(`tables/trades/${t.id}`, { method: 'DELETE' });
        load();
      });
      const closeBtn = tr.querySelector('.jr-closebtn');
      if (closeBtn) closeBtn.addEventListener('click', () => closeTrade(t));
      tbody.appendChild(tr);
    }
  }

  async function closeTrade(t) {
    const exitStr = prompt(`Exit price for ${t.symbol} ${t.side} (entry ${t.entry}):`);
    if (!exitStr) return;
    const exit = +exitStr;
    if (!(exit > 0)) return alert('Invalid price');
    const upd = { ...t, exit };
    upd.pnl = computePnl(upd);
    upd.status = statusOf(upd);
    upd.closed_at = new Date().toISOString();
    await fetch(`tables/trades/${t.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upd),
    });
    load();
  }

  // ---- Modal ----
  const modal = document.getElementById('trade-modal');
  document.getElementById('new-trade-btn').addEventListener('click', () => {
    modal.classList.remove('hidden');
    const q = new URLSearchParams(location.search);
    if (q.get('symbol')) document.getElementById('tr-symbol').value = q.get('symbol');
    document.getElementById('tr-symbol').focus();
  });
  document.getElementById('trade-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('trade-save').addEventListener('click', async () => {
    const t = {
      symbol: document.getElementById('tr-symbol').value.trim().toUpperCase(),
      side: document.getElementById('tr-side').value,
      entry: +document.getElementById('tr-entry').value || 0,
      exit: +document.getElementById('tr-exit').value || 0,
      quantity: +document.getElementById('tr-qty').value || 0,
      stop: +document.getElementById('tr-stop').value || 0,
      target: +document.getElementById('tr-target').value || 0,
      notes: document.getElementById('tr-notes').value,
      opened_at: new Date().toISOString(),
      closed_at: null,
    };
    if (!t.symbol || !t.entry) return alert('Symbol and entry price are required.');
    t.pnl = computePnl(t) || 0;
    t.status = statusOf(t);
    if (t.status !== 'OPEN') t.closed_at = new Date().toISOString();
    await fetch('tables/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
    });
    modal.classList.add('hidden');
    ['tr-symbol', 'tr-entry', 'tr-exit', 'tr-qty', 'tr-stop', 'tr-target', 'tr-notes'].forEach(id =>
      document.getElementById(id).value = '');
    load();
  });

  function fmt(v) {
    if (v == null || isNaN(v) || v === 0) return '—';
    if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return v.toFixed(2);
    return v.toPrecision(4);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  load();
})();
