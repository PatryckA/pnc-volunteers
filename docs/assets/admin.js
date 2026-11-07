/* Admin console: events, slots, volunteers, emails */
(function () {
  const app = $('#app');
  let token = store.get('pnc_admin')?.token || null;
  let current = null;   // event being edited
  let dirty = false;
  let tab = 'setup';

  const call = (path, opts = {}) => api(path, { ...opts, token }).catch(err => {
    if (err.status === 401) { logout(err.message); }
    throw err;
  });

  function logout(msg) {
    token = null; store.del('pnc_admin');
    showLogin(msg);
  }

  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------- Login ---------------- */
  function showLogin(msg) {
    app.innerHTML = `
      <div class="card" style="max-width:420px;margin:40px auto">
        <h1 style="margin-top:4px">Admin login</h1>
        ${msg && msg !== 'Please log in.' ? `<div class="notice">${esc(msg)}</div>` : ''}
        <form id="login">
          <label for="pw">Committee password</label>
          <input id="pw" type="password" autocomplete="current-password" required>
          <div id="login-err"></div>
          <button class="btn block" style="margin-top:16px">Log in</button>
        </form>
      </div>`;
    $('#pw').focus();
    $('#login').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
        token = r.token; store.set('pnc_admin', { token });
        route();
      } catch (err) { $('#login-err').innerHTML = `<div class="error">${esc(err.message)}</div>`; }
    });
  }

  /* ---------------- Routing ---------------- */
  window.addEventListener('hashchange', () => route());
  function go(hash) {
    if (dirty && !window.confirm('You have unsaved changes. Leave without saving?')) return;
    dirty = false;
    location.hash = hash;
  }

  async function route() {
    if (!token) return showLogin();
    const h = location.hash.slice(1);
    dirty = false;
    if (h === 'new') return showEditor(blankEvent());
    const m = h.match(/^event\/(\d+)(?:\/(\w+))?$/);
    if (m) {
      tab = m[2] === 'volunteers' ? 'volunteers' : 'setup';
      app.innerHTML = '<div class="spinner"></div>';
      try { const { event } = await call('/api/admin/events/' + m[1]); return showEditor(event); }
      catch (err) { app.innerHTML = `<div class="error">${esc(err.message)}</div><p><a href="#">Back to events</a></p>`; return; }
    }
    return showList();
  }

  /* ---------------- Event list ---------------- */
  async function showList() {
    app.innerHTML = '<div class="spinner"></div>';
    let events, status;
    try { [{ events }, status] = await Promise.all([call('/api/admin/events'), call('/api/admin/status')]); }
    catch (err) { if (token) app.innerHTML = `<div class="error">${esc(err.message)}</div>`; return; }
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = events.filter(e => !e.last_date || e.last_date >= today);
    const past = events.filter(e => e.last_date && e.last_date < today);
    const rows = list => list.map(e => `
      <tr class="click" data-id="${e.id}">
        <td><strong>${esc(e.title)}</strong>${e.location ? `<div class="small muted">${esc(e.location)}</div>` : ''}</td>
        <td class="hide-sm">${esc(fmtRange(e.first_date, e.last_date)) || '<span class="muted">No slots</span>'}</td>
        <td>${e.published ? '<span class="badge">Live</span>' : '<span class="badge draft">Draft</span>'}</td>
        <td>${e.filled} / ${e.capacity}</td>
      </tr>`).join('');
    const table = (list, empty) => list.length ? `
      <table class="list"><thead><tr><th>Event</th><th class="hide-sm">Dates</th><th>Status</th><th>Filled</th></tr></thead>
      <tbody>${rows(list)}</tbody></table>` : `<p class="muted">${empty}</p>`;

    app.innerHTML = `
      <div class="toolbar" style="margin-top:20px">
        <h1 style="margin:0">Events</h1><span class="spacer"></span>
        <button class="btn" id="new">+ New event</button>
        <button class="btn secondary small" id="logout">Log out</button>
      </div>
      ${emailStatusHtml(status)}
      <h2>Upcoming and drafts</h2>${table(upcoming, 'No upcoming events yet. Create one, or duplicate a past event.')}
      ${past.length ? `<h2>Past</h2>${table(past, '')}` : ''}`;
    $('#new').onclick = () => go('new');
    $('#logout').onclick = () => logout();
    $$('tr.click').forEach(tr => tr.onclick = () => go('event/' + tr.dataset.id));
  }

  function emailStatusHtml(s) {
    const modeNote = s.email_mode !== 'graph' ? `<div class="notice">Email is in <strong>test mode</strong>: emails are logged, not sent. Set EMAIL_MODE to "graph" in Cloudflare once Microsoft 365 is connected.</div>` : '';
    const failNote = s.failed_7d ? `<div class="error">${s.failed_7d} email(s) failed to send in the last 7 days. Check the Microsoft 365 settings in Cloudflare.</div>` : '';
    return `${modeNote}${failNote}
      <div class="card small" style="margin-top:14px">
        <span class="stat"><b>${s.sent_24h}</b>emails sent (24h)</span>
        <span class="stat"><b>${s.remaining_24h}</b>left today of ${s.daily_limit}</span>
        <span class="stat"><b>${s.queued}</b>waiting in queue</span>
        ${s.queued ? '<div class="muted" style="margin-top:6px">Queued emails send automatically each hour while under the daily limit.</div>' : ''}
      </div>`;
  }

  /* ---------------- Editor ---------------- */
  function blankEvent() {
    return { id: null, title: '', description: '', location: '', contact_name: '', contact_email: '', published: 0,
      slots: [{ title: '', details: '', date: '', start_time: '09:00', end_time: '10:00', capacity: 2, signups: [] }] };
  }

  function showEditor(ev) {
    current = ev;
    const saved = !!ev.id;
    const filled = ev.slots.reduce((n, s) => n + (s.signups?.length || 0), 0);
    const cap = ev.slots.reduce((n, s) => n + (+s.capacity || 0), 0);
    app.innerHTML = `
      <p style="margin:16px 0 0"><a href="#" id="back">&larr; All events</a></p>
      <div class="toolbar" style="margin-top:8px">
        <h1 style="margin:0">${saved ? esc(ev.title) : 'New event'}</h1>
        ${saved ? (ev.published ? '<span class="badge">Live</span>' : '<span class="badge draft">Draft</span>') : ''}
      </div>
      ${saved ? `<div class="toolbar" style="margin-top:12px">
        <button class="btn secondary small" id="copylink">Copy volunteer link</button>
        <a class="btn secondary small" href="event.html?id=${ev.id}" target="_blank" rel="noopener">Preview</a>
        <button class="btn secondary small" id="dup">Duplicate event</button>
        <button class="btn secondary small" id="print">Print sign-in sheet</button>
        <button class="btn secondary small" id="mail">Email volunteers</button>
        <span class="spacer"></span>
        <button class="btn danger small" id="del">Delete event</button>
      </div>` : ''}
      ${saved ? `<div class="tabs">
        <button data-tab="setup" class="${tab === 'setup' ? 'active' : ''}">Details &amp; slots</button>
        <button data-tab="volunteers" class="${tab === 'volunteers' ? 'active' : ''}">Volunteers (${filled}/${cap})</button>
      </div>` : '<div style="height:12px"></div>'}
      <div id="tab-body"></div>`;
    $('#back').onclick = e => { e.preventDefault(); go(''); };
    $$('.tabs button').forEach(b => b.onclick = () => {
      if (dirty && !window.confirm('You have unsaved changes. Switch tabs without saving?')) return;
      dirty = false;
      history.replaceState(null, '', '#event/' + ev.id + (b.dataset.tab === 'volunteers' ? '/volunteers' : ''));
      tab = b.dataset.tab; showEditor(current);
    });
    if (saved) {
      $('#copylink').onclick = () => copyLink(ev.id);
      $('#dup').onclick = () => duplicateModal(ev);
      $('#print').onclick = () => printSignIn(ev);
      $('#mail').onclick = () => emailModal(ev);
      $('#del').onclick = () => deleteModal(ev);
    }
    if (tab === 'volunteers' && saved) renderVolunteers(); else renderSetup();
  }

  function renderSetup() {
    const ev = current;
    $('#tab-body').innerHTML = `
      <form id="evform" class="card">
        <label for="f-title">Event name</label>
        <input id="f-title" data-k="title" type="text" value="${esc(ev.title)}" placeholder="e.g. Spring Fete" required>
        <div class="row">
          <div><label for="f-location">Location</label><input id="f-location" data-k="location" type="text" value="${esc(ev.location)}" placeholder="e.g. School hall"></div>
          <div><label class="check" style="margin-top:44px"><input type="checkbox" id="f-pub" ${ev.published ? 'checked' : ''}> Live (volunteers can see it)</label></div>
        </div>
        <label for="f-desc">Description <span class="opt">(shown at the top of the sign-up page)</span></label>
        <textarea id="f-desc" data-k="description" placeholder="What the event is and anything volunteers should know">${esc(ev.description)}</textarea>
        <div class="row">
          <div><label for="f-cn">Contact name <span class="opt">(optional)</span></label><input id="f-cn" data-k="contact_name" type="text" value="${esc(ev.contact_name)}"></div>
          <div><label for="f-ce">Contact email <span class="opt">(replies go here)</span></label><input id="f-ce" data-k="contact_email" type="email" value="${esc(ev.contact_email)}"></div>
        </div>
        <label for="f-du">Donation link <span class="opt">(optional: shows a "Donate instead" button, e.g. a Square link)</span></label>
        <input id="f-du" data-k="donation_url" type="url" value="${esc(ev.donation_url || '')}" placeholder="https://square.link/...">
        <label for="f-dx">Donation message <span class="opt">(optional)</span></label>
        <input id="f-dx" data-k="donation_text" type="text" value="${esc(ev.donation_text || '')}" placeholder="Can't bring something? You're welcome to donate instead.">
      </form>
      <div class="toolbar" style="margin-top:22px">
        <h2 style="margin:0">Time slots</h2><span class="spacer"></span>
        <button class="btn secondary small" id="addrun">+ Add a run of shifts</button>
        <button class="btn secondary small" id="addslot">+ Add slot</button>
      </div>
      <p class="small muted">Each slot is one task at one time. Volunteers take the whole slot.</p>
      <div id="slots" class="stack"></div>
      <div class="toolbar" style="margin-top:26px">
        <h2 style="margin:0">Things to bring</h2><span class="spacer"></span>
        <button class="btn secondary small" id="additem">+ Add item</button>
      </div>
      <p class="small muted">For bring-a-plate events, e.g. "Main dish" needing 6 people. Parents say what they'll bring and tick any dietary info.</p>
      <div id="dropoff" class="card hidden" style="margin-bottom:12px">
        <div class="row">
          <div><label for="f-dd" style="margin-top:0">Drop-off date</label><input id="f-dd" data-k="dropoff_date" type="date" value="${esc(ev.dropoff_date || '')}"></div>
          <div><label for="f-dt" style="margin-top:0">Drop off by</label><input id="f-dt" data-k="dropoff_time" type="time" step="300" value="${esc(ev.dropoff_time || '')}"></div>
        </div>
        <label for="f-dn">Where <span class="opt">(optional)</span></label>
        <input id="f-dn" data-k="dropoff_note" type="text" value="${esc(ev.dropoff_note || '')}" placeholder="e.g. Staffroom kitchen">
      </div>
      <div id="items" class="stack"></div>
      <div id="save-err"></div>
      <div class="actionbar show"><div class="inner">
        <span class="small muted" id="dirty-note">${ev.id ? 'All changes saved' : 'Not saved yet'}</span>
        <button class="btn" id="save">${ev.id ? 'Save changes' : 'Save event'}</button>
      </div></div>`;
    $$('#evform [data-k], #dropoff [data-k]').forEach(inp => inp.addEventListener('input', () => { ev[inp.dataset.k] = inp.value; markDirty(); }));
    $('#f-pub').addEventListener('change', e => { ev.published = e.target.checked ? 1 : 0; markDirty(); });
    $('#addslot').onclick = addSlot;
    $('#additem').onclick = addItem;
    $('#addrun').onclick = runModal;
    $('#save').onclick = save;
    renderSlots();
  }

  function markDirty() { dirty = true; const n = $('#dirty-note'); if (n) n.textContent = 'Unsaved changes'; }

  function renderSlots() {
    const entries = current.slots.map((s, i) => ({ s, i }));
    const shifts = entries.filter(e => e.s.kind !== 'item');
    const items = entries.filter(e => e.s.kind === 'item');
    const foot = (s, n) => `
        <div class="foot">
          <span class="muted">${n ? `${n} signed up` : ''}</span>
          <span>
            <button class="btn link" data-act="copy">Copy</button>
            <button class="btn link" data-act="remove" ${n ? 'disabled title="Remove the volunteers first"' : ''} style="color:var(--bad)">Remove</button>
          </span>
        </div>`;
    $('#slots').innerHTML = shifts.map(({ s, i }) => {
      const n = s.signups?.length || 0;
      return `
      <div class="slot-edit" data-i="${i}">
        <div class="grid">
          <div class="task"><label>Task</label><input type="text" data-k="title" value="${esc(s.title)}" placeholder="e.g. BBQ cooking"></div>
          <div><label>Date</label><input type="date" data-k="date" value="${esc(s.date)}"></div>
          <div><label>Start</label><input type="time" data-k="start_time" value="${esc(s.start_time)}" step="300"></div>
          <div><label>End</label><input type="time" data-k="end_time" value="${esc(s.end_time)}" step="300"></div>
          <div><label>People</label><input type="number" data-k="capacity" min="${Math.max(1, n)}" max="500" value="${esc(s.capacity)}"></div>
        </div>
        <textarea data-k="details" placeholder="Task details (optional): what's involved, what to bring, where to go">${esc(s.details)}</textarea>
        ${foot(s, n)}
      </div>`;
    }).join('') || '<p class="muted small">No time slots.</p>';
    $('#items').innerHTML = items.map(({ s, i }) => {
      const n = s.signups?.length || 0;
      return `
      <div class="slot-edit item" data-i="${i}">
        <div class="grid item-grid">
          <div><label>Item</label><input type="text" data-k="title" value="${esc(s.title)}" placeholder="e.g. Main dish"></div>
          <div><label>How many</label><input type="number" data-k="capacity" min="${Math.max(1, n)}" max="500" value="${esc(s.capacity)}"></div>
        </div>
        <textarea data-k="details" placeholder="Details (optional), e.g. serves 8, please bring in a disposable dish">${esc(s.details)}</textarea>
        ${foot(s, n)}
      </div>`;
    }).join('');
    $('#dropoff').classList.toggle('hidden', !items.length);
    $$('.slot-edit').forEach(el => {
      const s = current.slots[+el.dataset.i];
      $$('[data-k]', el).forEach(inp => inp.addEventListener('input', () => { s[inp.dataset.k] = inp.value; markDirty(); }));
      $('[data-act=copy]', el).onclick = () => {
        current.slots.splice(+el.dataset.i + 1, 0, { ...s, id: undefined, signups: [] });
        markDirty(); renderSlots();
      };
      $('[data-act=remove]', el).onclick = () => { current.slots.splice(+el.dataset.i, 1); markDirty(); renderSlots(); };
    });
  }

  function dropBlankStarter() {
    // a brand-new event starts with one empty time slot; drop it if unused
    const only = current.slots.length === 1 && current.slots[0];
    if (only && only.kind !== 'item' && !only.id && !only.title && !only.date) current.slots = [];
  }

  function addItem() {
    dropBlankStarter();
    current.slots.push({ kind: 'item', title: '', details: '', capacity: 4, signups: [] });
    markDirty(); renderSlots();
    const els = $$('#items .slot-edit'); const last = els[els.length - 1];
    last.scrollIntoView({ behavior: 'smooth', block: 'center' }); $('input', last).focus();
  }

  function addSlot() {
    const shiftsOnly = current.slots.filter(s => s.kind !== 'item');
    const last = shiftsOnly[shiftsOnly.length - 1];
    let next = { title: '', details: '', date: '', start_time: '09:00', end_time: '10:00', capacity: 2, signups: [] };
    if (last) {
      // continue straight after the previous slot, same length
      const mins = toMin(last.end_time) - toMin(last.start_time);
      next = { ...next, title: last.title, details: last.details, date: last.date, capacity: last.capacity,
        start_time: last.end_time, end_time: fromMin(Math.min(toMin(last.end_time) + (mins > 0 ? mins : 60), 23 * 60 + 55)) };
    }
    current.slots.push(next);
    markDirty(); renderSlots();
    const els = $$('#slots .slot-edit'); els[els.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const toMin = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
  const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  async function save() {
    const btn = $('#save');
    $('#save-err').innerHTML = '';
    btn.disabled = true; btn.textContent = 'Saving…';
    const body = { ...current, slots: current.slots.map(({ signups, start_utc, event_id, sort_order, ...s }) => s) };
    try {
      const { event } = current.id
        ? await call('/api/admin/events/' + current.id, { method: 'PUT', body })
        : await call('/api/admin/events', { method: 'POST', body });
      dirty = false;
      toast(event.published ? 'Saved. The event is live.' : 'Saved as a draft. Tick "Live" when it\'s ready.');
      history.replaceState(null, '', '#event/' + event.id);
      showEditor(event);
    } catch (err) {
      $('#save-err').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = current.id ? 'Save changes' : 'Save event';
    }
  }

  /* ---------------- Volunteers tab ---------------- */
  const DIET = { veg: 'Vegetarian', vegan: 'Vegan', gf: 'Gluten free', nf: 'Nut free', df: 'Dairy free' };
  const dietLabels = codes => String(codes || '').split(',').filter(c => DIET[c]).map(c => DIET[c]);
  const slotLabel = s => s.kind === 'item'
    ? `Bring: ${esc(s.title)}`
    : `${esc(fmtDateShort(s.date))}, ${fmtTime(s.start_time)} to ${fmtTime(s.end_time)} · ${esc(s.title)}`;
  function renderVolunteers() {
    const ev = current;
    $('#tab-body').innerHTML = `
      <div class="toolbar"><span class="muted small">Contact details are only visible to admins.</span><span class="spacer"></span>
        <button class="btn small" id="addvol">+ Add volunteer</button></div>
      ${ev.slots.map(s => `
        <h2 style="font-size:17px">${slotLabel(s)}
          <span class="badge ${s.signups.length >= s.capacity ? 'full' : ''}" style="margin-left:6px">${s.signups.length}/${s.capacity}</span></h2>
        ${s.signups.length ? `<table class="list roster"><thead><tr><th>Name</th>${s.kind === 'item' ? '<th>Bringing</th>' : ''}<th>Mobile</th><th class="hide-sm">Email</th><th class="hide-sm">Comments</th><th></th></tr></thead><tbody>
          ${s.signups.map(g => `<tr>
            <td>${esc(g.first_name)} ${esc(g.last_name)}</td>
            ${s.kind === 'item' ? `<td><strong>${esc(g.item_desc)}</strong>${dietLabels(g.dietary).map(d => `<span class="diet">${esc(d)}</span>`).join('')}</td>` : ''}
            <td><a href="tel:${esc(g.mobile.replace(/\s/g, ''))}">${esc(g.mobile)}</a></td>
            <td class="hide-sm"><a href="mailto:${esc(g.email)}">${esc(g.email)}</a></td>
            <td class="hide-sm">${esc(g.comments)}</td>
            <td style="text-align:right"><button class="btn danger small" data-rm="${g.id}">Remove</button></td>
          </tr>`).join('')}</tbody></table>` : '<p class="muted small">Nobody yet.</p>'}`).join('')}`;
    $('#addvol').onclick = () => addVolunteerModal();
    $$('[data-rm]').forEach(b => b.onclick = async () => {
      if (!b.classList.contains('confirm')) { b.classList.add('confirm'); b.textContent = 'Confirm'; setTimeout(() => { b.classList.remove('confirm'); b.textContent = 'Remove'; }, 4000); return; }
      try { const { event } = await call('/api/admin/signups/' + b.dataset.rm, { method: 'DELETE' }); toast('Volunteer removed.'); showEditor(event); }
      catch (err) { toast(err.message, 'bad'); }
    });
  }

  /* ---------------- Modals ---------------- */
  function modal(html, onReady) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const close = () => (root.innerHTML = '');
    $('.modal-backdrop', root).addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) close(); });
    $$('[data-close]', root).forEach(b => b.onclick = close);
    onReady && onReady($('.modal', root), close);
  }

  function runModal() {
    const shiftsOnly = current.slots.filter(s => s.kind !== 'item');
    const last = shiftsOnly[shiftsOnly.length - 1] || {};
    modal(`
      <h2>Add a run of shifts</h2>
      <p class="small muted">Creates back-to-back slots, e.g. BBQ from 9am to 1pm in 1 hour shifts.</p>
      <label>Task</label><input type="text" id="r-title" value="${esc(last.title || '')}" placeholder="e.g. BBQ cooking">
      <label>Task details <span class="opt">(optional)</span></label><textarea id="r-details">${esc(last.details || '')}</textarea>
      <div class="row"><div><label>Date</label><input type="date" id="r-date" value="${esc(last.date || '')}"></div>
        <div><label>People per shift</label><input type="number" id="r-cap" min="1" value="${esc(last.capacity || 2)}"></div></div>
      <div class="row"><div><label>From</label><input type="time" id="r-from" value="09:00" step="300"></div>
        <div><label>To</label><input type="time" id="r-to" value="13:00" step="300"></div></div>
      <label>Shift length</label>
      <select id="r-len"><option value="30">30 minutes</option><option value="60" selected>1 hour</option><option value="90">1.5 hours</option><option value="120">2 hours</option><option value="180">3 hours</option></select>
      <div id="r-err"></div>
      <div class="actions"><button class="btn secondary" data-close>Cancel</button><button class="btn" id="r-go">Add shifts</button></div>`,
    (m, close) => {
      $('#r-go', m).onclick = () => {
        const title = $('#r-title', m).value.trim(), date = $('#r-date', m).value;
        const from = toMin($('#r-from', m).value), to = toMin($('#r-to', m).value), len = +$('#r-len', m).value;
        if (!title || !date || to <= from) { $('#r-err', m).innerHTML = '<div class="error">Please enter a task, a date, and a "To" time after "From".</div>'; return; }
        // drop a blank starter slot if that's all there is
        dropBlankStarter();
        for (let t = from; t < to; t += len) {
          current.slots.push({ title, details: $('#r-details', m).value, date, start_time: fromMin(t), end_time: fromMin(Math.min(t + len, to)), capacity: +$('#r-cap', m).value || 1, signups: [] });
        }
        close(); markDirty(); renderSlots();
      };
    });
  }

  function addVolunteerModal() {
    modal(`
      <h2>Add a volunteer</h2>
      <label>Slot</label>
      <select id="v-slot">${current.slots.map(s => `<option value="${s.id}" data-kind="${s.kind || 'shift'}">${s.kind === 'item' ? 'Bring: ' + esc(s.title) : `${esc(fmtDateShort(s.date))} ${fmtTime(s.start_time)}, ${esc(s.title)}`} (${s.signups.length}/${s.capacity})</option>`).join('')}</select>
      <div id="v-item" class="hidden">
        <label>Bringing</label><input type="text" id="v-desc" placeholder="e.g. Chicken curry">
        <div class="diet-choices">${Object.entries(DIET).map(([c, l]) => `<label class="chip"><input type="checkbox" value="${c}"> ${l}</label>`).join('')}</div>
      </div>
      <div class="row"><div><label>First name</label><input type="text" id="v-first"></div><div><label>Last name</label><input type="text" id="v-last"></div></div>
      <label>Email</label><input type="email" id="v-email">
      <label>Mobile</label><input type="tel" id="v-mobile" placeholder="0412 345 678">
      <label>Comments <span class="opt">(optional)</span></label><input type="text" id="v-comments">
      <label class="check" style="margin-top:14px"><input type="checkbox" id="v-send" checked> Email them a confirmation</label>
      <p class="small muted">Admins can add people even when a slot is full.</p>
      <div id="v-err"></div>
      <div class="actions"><button class="btn secondary" data-close>Cancel</button><button class="btn" id="v-go">Add volunteer</button></div>`,
    (m, close) => {
      const syncKind = () => $('#v-item', m).classList.toggle('hidden', $('#v-slot', m).selectedOptions[0]?.dataset.kind !== 'item');
      $('#v-slot', m).onchange = syncKind; syncKind();
      $('#v-go', m).onclick = async () => {
        try {
          const { event } = await call('/api/admin/signups', { method: 'POST', body: {
            slot_id: +$('#v-slot', m).value, first_name: $('#v-first', m).value, last_name: $('#v-last', m).value,
            email: $('#v-email', m).value, mobile: $('#v-mobile', m).value, comments: $('#v-comments', m).value, send_email: $('#v-send', m).checked,
            item_desc: $('#v-desc', m).value, dietary: $$('#v-item input:checked', m).map(c => c.value) } });
          close(); toast('Volunteer added.'); showEditor(event);
        } catch (err) { $('#v-err', m).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
      };
    });
  }

  function duplicateModal(ev) {
    modal(`
      <h2>Duplicate event</h2>
      <p class="small muted">Copies the details and all slots (not the volunteers). The copy starts as a draft.</p>
      <label>New event name</label><input type="text" id="d-title" value="${esc(ev.title)}">
      <label>Date of the first slot (or drop-off)</label><input type="date" id="d-date" value="${esc(ev.slots[0]?.date || '')}">
      <p class="small muted">All slots move by the same number of days, so multi-day events stay in order.</p>
      <div id="d-err"></div>
      <div class="actions"><button class="btn secondary" data-close>Cancel</button><button class="btn" id="d-go">Duplicate</button></div>`,
    (m, close) => {
      $('#d-go', m).onclick = async () => {
        try {
          const { event } = await call(`/api/admin/events/${ev.id}/duplicate`, { method: 'POST', body: { title: $('#d-title', m).value, new_date: $('#d-date', m).value } });
          close(); toast('Copy created as a draft.'); tab = 'setup'; location.hash = 'event/' + event.id;
        } catch (err) { $('#d-err', m).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
      };
    });
  }

  async function emailModal(ev) {
    let status;
    try { status = await call('/api/admin/status'); } catch { return; }
    const people = new Set(ev.slots.flatMap(s => s.signups.map(g => g.email.toLowerCase())));
    modal(`
      <h2>Email volunteers</h2>
      <label>Send to</label>
      <select id="m-to"><option value="">Everyone signed up (${people.size} ${people.size === 1 ? 'person' : 'people'})</option>
        ${ev.slots.filter(s => s.signups.length).map(s => `<option value="${s.id}">Only: ${s.kind === 'item' ? 'Bring: ' + esc(s.title) : `${esc(fmtDateShort(s.date))} ${fmtTime(s.start_time)}, ${esc(s.title)}`} (${s.signups.length})</option>`).join('')}</select>
      <label>Subject</label><input type="text" id="m-subj" value="${esc(ev.title)}: update">
      <label>Message</label><textarea id="m-msg" style="min-height:160px" placeholder="Each email starts with 'Hi [first name],' automatically."></textarea>
      <p class="small muted">${status.remaining_24h} emails left today (limit ${status.daily_limit}). Extras wait in the queue and send automatically within the next day.${ev.contact_email ? ` Replies go to ${esc(ev.contact_email)}.` : ''}</p>
      <div id="m-err"></div>
      <div class="actions"><button class="btn secondary" data-close>Cancel</button><button class="btn" id="m-go" ${people.size ? '' : 'disabled'}>Send</button></div>`,
    (m, close) => {
      $('#m-go', m).onclick = async () => {
        const slot = $('#m-to', m).value;
        try {
          const r = await call(`/api/admin/events/${ev.id}/email`, { method: 'POST', body: { subject: $('#m-subj', m).value, message: $('#m-msg', m).value, slot_ids: slot ? [+slot] : [] } });
          close(); toast(`Email queued for ${r.queued} ${r.queued === 1 ? 'person' : 'people'}.`);
        } catch (err) { $('#m-err', m).innerHTML = `<div class="error">${esc(err.message)}</div>`; }
      };
    });
  }

  function deleteModal(ev) {
    const n = ev.slots.reduce((a, s) => a + s.signups.length, 0);
    modal(`
      <h2>Delete "${esc(ev.title)}"?</h2>
      <p>This permanently removes the event, its ${ev.slots.length} slot(s)${n ? ` and <strong>${n} volunteer sign-up(s)</strong>` : ''}. Volunteers are not emailed.</p>
      ${n ? '<p class="small muted">Tip: print the sign-in sheet first if you want a record.</p>' : ''}
      <div class="actions"><button class="btn secondary" data-close>Keep it</button><button class="btn danger confirm" id="x-go">Delete</button></div>`,
    (m, close) => {
      $('#x-go', m).onclick = async () => {
        try { await call('/api/admin/events/' + ev.id, { method: 'DELETE' }); close(); dirty = false; toast('Event deleted.'); location.hash = ''; }
        catch (err) { toast(err.message, 'bad'); }
      };
    });
  }

  function printSignIn(ev) {
    // One row per volunteer (matched by email), listing every slot or item they signed up for
    const people = new Map();
    for (const s of ev.slots) {
      for (const g of s.signups) {
        const key = g.email.toLowerCase();
        if (!people.has(key)) people.set(key, { first: g.first_name, last: g.last_name, entries: [] });
        people.get(key).entries.push({ s, g });
      }
    }
    const rows = [...people.values()].sort((a, b) => (a.last + ' ' + a.first).localeCompare(b.last + ' ' + b.first, 'en', { sensitivity: 'base' }));
    const dates = [...new Set(ev.slots.map(s => s.date))].sort();
    const describe = ({ s, g }) => s.kind === 'item'
      ? `Bringing: ${esc(g.item_desc)} <span class="sub">(${esc(s.title)})</span>`
      : `${fmtTime(s.start_time)} to ${fmtTime(s.end_time)} <span class="sub">${esc(s.title)}${dates.length > 1 ? ', ' + esc(fmtDateShort(s.date)) : ''}</span>`;
    const logo = PNC_CONFIG.logo ? new URL(PNC_CONFIG.logo, location.href).href : '';
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign-in sheet: ${esc(ev.title)}</title>
      <style>
        @page { size: A4 portrait; margin: 14mm; }
        body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 0; }
        header { display: flex; align-items: center; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 14px; }
        header img { height: 64px; width: auto; }
        h1 { font-size: 22px; margin: 0; }
        .meta { font-size: 13px; color: #444; margin-top: 2px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th { text-align: left; border-bottom: 2px solid #111; padding: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
        td { border-bottom: 1px solid #999; padding: 8px 6px; vertical-align: top; }
        tr { page-break-inside: avoid; }
        td.name { width: 30%; font-weight: 600; }
        td.sign { width: 24%; }
        .slot + .slot { margin-top: 3px; }
        .sub { color: #555; }
        .empty td { height: 26px; }
        .noprint { margin: 12px 0; font-size: 14px; }
        @media print { .noprint { display: none; } }
      </style></head><body>
      <div class="noprint"><button onclick="print()">Print</button> ${rows.length} volunteer${rows.length === 1 ? '' : 's'}</div>
      <header>
        ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
        <div><h1>${esc(ev.title)}</h1>
          <div class="meta">${esc(PNC_CONFIG.orgName || '')} · Volunteer sign-in${dates.length ? ' · ' + esc(fmtRange(dates[0], dates[dates.length - 1])) : ''}${ev.location ? ' · ' + esc(ev.location) : ''}</div></div>
      </header>
      <table><thead><tr><th>Volunteer name</th><th>Time slot(s)</th><th>Sign in</th></tr></thead><tbody>
        ${rows.map(p => `<tr><td class="name">${esc(p.first)} ${esc(p.last)}</td>
          <td>${p.entries.sort((a, b) => (a.s.date + a.s.start_time).localeCompare(b.s.date + b.s.start_time)).map(e => `<div class="slot">${describe(e)}</div>`).join('')}</td>
          <td class="sign"></td></tr>`).join('')}
        ${'<tr class="empty"><td></td><td></td><td></td></tr>'.repeat(5)}
      </tbody></table>
      <script>window.onload = () => setTimeout(() => print(), 300);<\/script>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast('Please allow pop-ups for this site to print.', 'bad'); return; }
    w.document.open(); w.document.write(html); w.document.close();
  }

  function copyLink(id) {
    const url = location.href.replace(/admin\.html.*$/, '') + 'event.html?id=' + id;
    const done = () => toast('Link copied. Paste it into your newsletter or class chat.');
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => window.prompt('Copy this link:', url));
    else window.prompt('Copy this link:', url);
  }

  route();
})();
