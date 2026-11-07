/* Shared helpers for all pages */
(function () {
  const cfg = window.PNC_CONFIG || {};
  document.documentElement.style.setProperty('--accent', cfg.accent || '#1f5f8b');

  window.$ = (sel, root = document) => root.querySelector(sel);
  window.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  window.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.nl2br = s => esc(s).replace(/\n/g, '<br>');

  window.api = async function (path, { method = 'GET', body, token, raw } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(cfg.apiUrl.replace(/\/$/, '') + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('Could not connect. Please check your internet connection and try again.'), { status: 0 });
    }
    if (raw && res.ok) return res;
    let data = {};
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok && !(res.status === 409 && data.problems)) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status, data });
    return data;
  };

  window.fmtDate = (d, opts) => new Date(d + 'T12:00:00').toLocaleDateString('en-AU', opts || { weekday: 'long', day: 'numeric', month: 'long' });
  window.fmtDateShort = d => new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  window.fmtTime = t => {
    let [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
  };
  window.fmtRange = (d1, d2) => (!d1 ? '' : d1 === d2 ? fmtDate(d1) : `${fmtDateShort(d1)} to ${fmtDateShort(d2)}`);

  window.store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  window.toast = function (msg, type = 'ok') {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.className = 'toast show ' + type;
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'toast'), 3500);
  };

  // Fill in the standard header
  document.addEventListener('DOMContentLoaded', () => {
    const h = $('#site-header');
    if (h) {
      h.innerHTML = `<a href="index.html" class="brand">${cfg.logo ? `<img src="${esc(cfg.logo)}" alt="">` : ''}<span>${esc(cfg.orgName || 'P&C')}<small>Volunteers</small></span></a>`;
    }
  });
})();
