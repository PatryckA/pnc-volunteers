/**
 * P&C Volunteer Sign-up API (Cloudflare Worker, single file, no dependencies)
 *
 * Bindings / settings (Cloudflare dashboard > Worker > Settings):
 *   DB                 D1 database binding (required)
 *   ADMIN_PASSWORD     secret: shared committee password
 *   SESSION_SECRET     secret: any long random string
 *   SITE_URL           e.g. https://patrycka.github.io/pnc-volunteers  (no trailing slash)
 *   ALLOWED_ORIGIN     e.g. https://patrycka.github.io  (comma-separate several)
 *   ORG_NAME           e.g. "Example Public School P&C"
 *   TIMEZONE           default Australia/Sydney
 *   EMAIL_MODE         "graph" to send via Microsoft 365, "log" to only log (testing)
 *   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET (secret), MS_SENDER (mailbox address)
 *   DAILY_EMAIL_LIMIT  default 90 (Microsoft caps onmicrosoft.com at 100 external/day)
 *   REMINDER_HOURS     default 24
 */

const MAX_SLOTS_PER_SIGNUP = 20;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(request, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err.stack || err);
      return json({ error: status === 500 ? 'Something went wrong. Please try again.' : err.message }, status, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHourly(env));
  },
};

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  let match;

  // Public
  if (m === 'GET' && p === '/api/events') return listPublicEvents(env);
  if (m === 'GET' && (match = p.match(/^\/api\/events\/(\d+)$/))) return getPublicEvent(env, +match[1]);
  if (m === 'POST' && p === '/api/signups') return createSignups(request, env, ctx);
  if (m === 'GET' && (match = p.match(/^\/api\/manage\/([\w-]{20,})$/))) return getManage(env, match[1]);
  if (m === 'DELETE' && (match = p.match(/^\/api\/manage\/([\w-]{20,})\/(\d+)$/))) return cancelOwnSignup(env, match[1], +match[2]);

  // Admin
  if (m === 'POST' && p === '/api/admin/login') return adminLogin(request, env);
  if (p.startsWith('/api/admin/')) {
    await requireAdmin(request, env);
    if (m === 'GET' && p === '/api/admin/status') return adminStatus(env);
    if (m === 'GET' && p === '/api/admin/events') return adminListEvents(env);
    if (m === 'POST' && p === '/api/admin/events') return adminSaveEvent(request, env, null);
    if ((match = p.match(/^\/api\/admin\/events\/(\d+)$/))) {
      const id = +match[1];
      if (m === 'GET') return adminGetEvent(env, id);
      if (m === 'PUT') return adminSaveEvent(request, env, id);
      if (m === 'DELETE') return adminDeleteEvent(env, id);
    }
    if (m === 'POST' && (match = p.match(/^\/api\/admin\/events\/(\d+)\/duplicate$/))) return adminDuplicate(request, env, +match[1]);
    if (m === 'GET' && (match = p.match(/^\/api\/admin\/events\/(\d+)\/export$/))) return adminExport(env, +match[1]);
    if (m === 'POST' && (match = p.match(/^\/api\/admin\/events\/(\d+)\/email$/))) return adminEmailVolunteers(request, env, ctx, +match[1]);
    if (m === 'POST' && p === '/api/admin/signups') return adminAddSignup(request, env, ctx);
    if (m === 'DELETE' && (match = p.match(/^\/api\/admin\/signups\/(\d+)$/))) return adminRemoveSignup(env, +match[1]);
    if (m === 'POST' && p === '/api/admin/process-queue') { await processQueue(env); return adminStatus(env); }
  }

  if (m === 'GET' && (p === '' || p === '/')) return json({ ok: true, service: 'P&C volunteer sign-up API' });
  throw httpError(404, 'Not found');
}

/* ------------------------------------------------------------------ */
/* Public endpoints                                                    */
/* ------------------------------------------------------------------ */

async function listPublicEvents(env) {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(`
    SELECT e.id, e.title, e.description, e.location,
           MIN(s.date) AS first_date, MAX(s.date) AS last_date,
           SUM(s.capacity) AS capacity,
           (SELECT COUNT(*) FROM signups g JOIN slots s2 ON s2.id = g.slot_id
             WHERE s2.event_id = e.id AND s2.start_utc > ?1) AS filled
    FROM events e JOIN slots s ON s.event_id = e.id
    WHERE e.published = 1 AND s.start_utc > ?1
    GROUP BY e.id
    ORDER BY first_date ASC, e.id ASC
  `).bind(now).all();
  return json({ events: results.map(r => ({ ...r, open: Math.max(0, r.capacity - r.filled) })) });
}

async function getPublicEvent(env, id) {
  const ev = await env.DB.prepare(
    `SELECT id, title, description, location, contact_name, contact_email FROM events WHERE id = ? AND published = 1`
  ).bind(id).first();
  if (!ev) throw httpError(404, 'This event could not be found. It may have been removed.');
  const { results: slots } = await env.DB.prepare(
    `SELECT id, title, details, date, start_time, end_time, capacity, start_utc FROM slots
     WHERE event_id = ? ORDER BY date, start_time, sort_order, id`
  ).bind(id).all();
  const { results: names } = await env.DB.prepare(
    `SELECT g.slot_id, g.first_name, g.last_name FROM signups g JOIN slots s ON s.id = g.slot_id
     WHERE s.event_id = ? ORDER BY g.id`
  ).bind(id).all();
  const now = new Date().toISOString();
  const bySlot = {};
  for (const n of names) (bySlot[n.slot_id] ||= []).push(displayName(n.first_name, n.last_name));
  ev.slots = slots.map(s => {
    const people = bySlot[s.id] || [];
    return {
      id: s.id, title: s.title, details: s.details, date: s.date,
      start_time: s.start_time, end_time: s.end_time, capacity: s.capacity,
      filled: people.length, names: people, closed: s.start_utc <= now,
    };
  });
  return json({ event: ev });
}

async function createSignups(request, env, ctx) {
  const body = await readJson(request);
  if (body.website) return json({ ok: true, created: [], problems: [] }); // honeypot: bots fill hidden field
  const person = validatePerson(body);
  const slotIds = [...new Set((body.slot_ids || []).map(Number).filter(Number.isInteger))];
  if (!slotIds.length) throw httpError(400, 'Please choose at least one time slot.');
  if (slotIds.length > MAX_SLOTS_PER_SIGNUP) throw httpError(400, 'That is a lot of slots! Please choose fewer.');

  const token = randomToken();
  const now = new Date();
  const reminderCutoff = new Date(now.getTime() + reminderHours(env) * 3600e3).toISOString();
  const created = [];
  const problems = [];

  for (const slotId of slotIds) {
    const slot = await env.DB.prepare(
      `SELECT s.*, e.title AS event_title, e.published FROM slots s JOIN events e ON e.id = s.event_id WHERE s.id = ?`
    ).bind(slotId).first();
    if (!slot || !slot.published) { problems.push({ slot_id: slotId, reason: 'This slot no longer exists.' }); continue; }
    const label = `${slot.title} (${fmtDate(slot.date)}, ${fmtTime(slot.start_time)})`;
    if (slot.start_utc <= now.toISOString()) { problems.push({ slot_id: slotId, reason: `${label} has already started.` }); continue; }
    const dup = await env.DB.prepare(`SELECT id FROM signups WHERE slot_id = ? AND lower(email) = lower(?)`).bind(slotId, person.email).first();
    if (dup) { problems.push({ slot_id: slotId, reason: `You are already signed up for ${label}.` }); continue; }

    const reminderSent = slot.start_utc <= reminderCutoff ? 1 : 0; // too close for a separate reminder
    const res = await env.DB.prepare(`
      INSERT INTO signups (slot_id, first_name, last_name, email, mobile, comments, manage_token, reminder_sent)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
      WHERE (SELECT COUNT(*) FROM signups WHERE slot_id = ?1) < (SELECT capacity FROM slots WHERE id = ?1)
    `).bind(slotId, person.first_name, person.last_name, person.email, person.mobile, person.comments, token, reminderSent).run();
    if (!res.meta.changes) { problems.push({ slot_id: slotId, reason: `Sorry, ${label} has just filled up.` }); continue; }
    created.push({ slot_id: slotId });
  }

  if (!created.length) return json({ ok: false, created, problems }, 409);

  await queueConfirmation(env, token);
  ctx.waitUntil(processQueue(env));
  return json({ ok: true, created, problems, manage_url: manageUrl(env, token) });
}

async function getManage(env, token) {
  const rows = await signupsForToken(env, token);
  if (!rows.length) throw httpError(404, 'We could not find any current sign-ups for this link. They may have been cancelled.');
  const now = new Date().toISOString();
  return json({
    first_name: rows[0].first_name,
    signups: rows.map(r => ({
      id: r.id, event_id: r.event_id, event_title: r.event_title, location: r.location,
      title: r.title, details: r.details, date: r.date, start_time: r.start_time, end_time: r.end_time,
      can_cancel: r.start_utc > now,
    })),
  });
}

async function cancelOwnSignup(env, token, id) {
  const row = await env.DB.prepare(
    `SELECT g.id, s.start_utc FROM signups g JOIN slots s ON s.id = g.slot_id WHERE g.id = ? AND g.manage_token = ?`
  ).bind(id, token).first();
  if (!row) throw httpError(404, 'That sign-up was not found. It may already be cancelled.');
  if (row.start_utc <= new Date().toISOString()) throw httpError(400, 'This slot has already started, so it can no longer be cancelled online. Please contact the organiser.');
  await env.DB.prepare(`DELETE FROM signups WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Admin endpoints                                                     */
/* ------------------------------------------------------------------ */

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) throw httpError(500, 'Admin password is not configured.');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { n } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > datetime('now', '-15 minutes')`
  ).bind(ip).first();
  if (n >= 8) throw httpError(429, 'Too many attempts. Please wait 15 minutes and try again.');
  const body = await readJson(request);
  if (!(await safeEqual(String(body.password || ''), env.ADMIN_PASSWORD))) {
    await env.DB.prepare(`INSERT INTO login_attempts (ip) VALUES (?)`).bind(ip).run();
    throw httpError(401, 'That password is not right.');
  }
  const exp = Date.now() + 12 * 3600e3;
  const payload = b64url(JSON.stringify({ exp }));
  const sig = await hmac(env.SESSION_SECRET, payload);
  return json({ token: `${payload}.${sig}`, expires: exp });
}

async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !env.SESSION_SECRET) throw httpError(401, 'Please log in.');
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (!(await safeEqual(sig, expected))) throw httpError(401, 'Please log in.');
  let data;
  try { data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw httpError(401, 'Please log in.'); }
  if (!data.exp || data.exp < Date.now()) throw httpError(401, 'Your session has expired. Please log in again.');
}

async function adminStatus(env) {
  const sent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_queue WHERE status = 'sent' AND sent_at > datetime('now', '-1 day')`).first();
  const queued = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_queue WHERE status = 'queued'`).first();
  const failed = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_queue WHERE status = 'failed' AND created_at > datetime('now', '-7 days')`).first();
  const limit = dailyLimit(env);
  return json({
    email_mode: env.EMAIL_MODE || 'log',
    sent_24h: sent.n, daily_limit: limit, remaining_24h: Math.max(0, limit - sent.n),
    queued: queued.n, failed_7d: failed.n,
    org_name: env.ORG_NAME || 'P&C',
  });
}

async function adminListEvents(env) {
  const { results } = await env.DB.prepare(`
    SELECT e.id, e.title, e.location, e.published,
      (SELECT MIN(date) FROM slots WHERE event_id = e.id) AS first_date,
      (SELECT MAX(date) FROM slots WHERE event_id = e.id) AS last_date,
      (SELECT COUNT(*) FROM slots WHERE event_id = e.id) AS slot_count,
      (SELECT COALESCE(SUM(capacity),0) FROM slots WHERE event_id = e.id) AS capacity,
      (SELECT COUNT(*) FROM signups g JOIN slots s ON s.id = g.slot_id WHERE s.event_id = e.id) AS filled
    FROM events e
    ORDER BY (first_date IS NULL) DESC, first_date DESC, e.id DESC
  `).all();
  return json({ events: results });
}

async function adminGetEvent(env, id) {
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!ev) throw httpError(404, 'Event not found.');
  const { results: slots } = await env.DB.prepare(
    `SELECT * FROM slots WHERE event_id = ? ORDER BY date, start_time, sort_order, id`).bind(id).all();
  const { results: signups } = await env.DB.prepare(
    `SELECT g.* FROM signups g JOIN slots s ON s.id = g.slot_id WHERE s.event_id = ? ORDER BY g.id`).bind(id).all();
  const bySlot = {};
  for (const g of signups) (bySlot[g.slot_id] ||= []).push(g);
  ev.slots = slots.map(s => ({ ...s, signups: bySlot[s.id] || [] }));
  return json({ event: ev });
}

async function adminSaveEvent(request, env, id) {
  const body = await readJson(request);
  const ev = {
    title: req(body.title, 'Event title', 120),
    description: opt(body.description, 4000),
    location: opt(body.location, 200),
    contact_name: opt(body.contact_name, 100),
    contact_email: opt(body.contact_email, 200),
    published: body.published ? 1 : 0,
  };
  if (ev.contact_email && !isEmail(ev.contact_email)) throw httpError(400, 'Contact email does not look right.');
  const tz = timezone(env);
  const slots = (body.slots || []).map((s, i) => {
    const slot = {
      id: s.id ? Number(s.id) : null,
      title: req(s.title, `Slot ${i + 1} task name`, 120),
      details: opt(s.details, 2000),
      date: s.date, start_time: s.start_time, end_time: s.end_time,
      capacity: Math.max(1, Math.min(500, parseInt(s.capacity, 10) || 1)),
      sort_order: i,
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.date || '')) throw httpError(400, `Slot ${i + 1} needs a date.`);
    if (!/^\d{2}:\d{2}$/.test(slot.start_time || '') || !/^\d{2}:\d{2}$/.test(slot.end_time || ''))
      throw httpError(400, `Slot ${i + 1} needs a start and end time.`);
    if (slot.end_time <= slot.start_time) throw httpError(400, `Slot ${i + 1}: end time must be after start time.`);
    slot.start_utc = localToUtc(slot.date, slot.start_time, tz).toISOString();
    return slot;
  });
  if (!slots.length) throw httpError(400, 'Add at least one time slot.');

  const stmts = [];
  if (id === null) {
    const r = await env.DB.prepare(
      `INSERT INTO events (title, description, location, contact_name, contact_email, published) VALUES (?,?,?,?,?,?)`
    ).bind(ev.title, ev.description, ev.location, ev.contact_name, ev.contact_email, ev.published).run();
    id = r.meta.last_row_id;
  } else {
    const exists = await env.DB.prepare(`SELECT id FROM events WHERE id = ?`).bind(id).first();
    if (!exists) throw httpError(404, 'Event not found.');
    stmts.push(env.DB.prepare(
      `UPDATE events SET title=?, description=?, location=?, contact_name=?, contact_email=?, published=? WHERE id=?`
    ).bind(ev.title, ev.description, ev.location, ev.contact_name, ev.contact_email, ev.published, id));

    // Slots removed by the admin: only allowed when nobody is signed up
    const { results: existing } = await env.DB.prepare(
      `SELECT s.id, s.title, (SELECT COUNT(*) FROM signups WHERE slot_id = s.id) AS n FROM slots s WHERE s.event_id = ?`
    ).bind(id).all();
    const keep = new Set(slots.filter(s => s.id).map(s => s.id));
    for (const ex of existing) {
      if (keep.has(ex.id)) continue;
      if (ex.n > 0) throw httpError(400, `"${ex.title}" has ${ex.n} volunteer(s). Remove them first before deleting the slot.`);
      stmts.push(env.DB.prepare(`DELETE FROM slots WHERE id = ?`).bind(ex.id));
    }
    // Capacity cannot drop below current sign-ups
    for (const s of slots.filter(s => s.id)) {
      const ex = existing.find(e => e.id === s.id);
      if (!ex) throw httpError(400, 'One of the slots no longer exists. Please reload and try again.');
      if (s.capacity < ex.n) throw httpError(400, `"${s.title}" already has ${ex.n} volunteers, so capacity cannot be less than ${ex.n}.`);
    }
  }
  for (const s of slots) {
    if (s.id) {
      // If the start time moved later than the reminder window, allow a fresh reminder
      stmts.push(env.DB.prepare(
        `UPDATE slots SET title=?, details=?, date=?, start_time=?, end_time=?, capacity=?, start_utc=?, sort_order=? WHERE id=? AND event_id=?`
      ).bind(s.title, s.details, s.date, s.start_time, s.end_time, s.capacity, s.start_utc, s.sort_order, s.id, id));
    } else {
      stmts.push(env.DB.prepare(
        `INSERT INTO slots (event_id, title, details, date, start_time, end_time, capacity, start_utc, sort_order) VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(id, s.title, s.details, s.date, s.start_time, s.end_time, s.capacity, s.start_utc, s.sort_order));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return adminGetEvent(env, id);
}

async function adminDeleteEvent(env, id) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM signups WHERE slot_id IN (SELECT id FROM slots WHERE event_id = ?)`).bind(id),
    env.DB.prepare(`DELETE FROM slots WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

async function adminDuplicate(request, env, id) {
  const body = await readJson(request);
  const src = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!src) throw httpError(404, 'Event not found.');
  const { results: slots } = await env.DB.prepare(`SELECT * FROM slots WHERE event_id = ? ORDER BY date, start_time, sort_order, id`).bind(id).all();
  // Shift every slot so the first one lands on the new date (keeps multi-day events intact)
  let shiftDays = 0;
  if (body.new_date && /^\d{4}-\d{2}-\d{2}$/.test(body.new_date) && slots.length) {
    shiftDays = Math.round((Date.parse(body.new_date + 'T00:00:00Z') - Date.parse(slots[0].date + 'T00:00:00Z')) / 86400e3);
  }
  const title = opt(body.title, 120) || `${src.title} (copy)`;
  const r = await env.DB.prepare(
    `INSERT INTO events (title, description, location, contact_name, contact_email, published) VALUES (?,?,?,?,?,0)`
  ).bind(title, src.description, src.location, src.contact_name, src.contact_email).run();
  const newId = r.meta.last_row_id;
  const tz = timezone(env);
  const stmts = slots.map(s => {
    const date = addDays(s.date, shiftDays);
    return env.DB.prepare(
      `INSERT INTO slots (event_id, title, details, date, start_time, end_time, capacity, start_utc, sort_order) VALUES (?,?,?,?,?,?,?,?,?)`
    ).bind(newId, s.title, s.details, date, s.start_time, s.end_time, s.capacity, localToUtc(date, s.start_time, tz).toISOString(), s.sort_order);
  });
  if (stmts.length) await env.DB.batch(stmts);
  return adminGetEvent(env, newId);
}

async function adminExport(env, id) {
  const ev = await env.DB.prepare(`SELECT title FROM events WHERE id = ?`).bind(id).first();
  if (!ev) throw httpError(404, 'Event not found.');
  const { results } = await env.DB.prepare(`
    SELECT s.date, s.start_time, s.end_time, s.title AS task, s.capacity,
           g.first_name, g.last_name, g.email, g.mobile, g.comments, g.created_at
    FROM slots s LEFT JOIN signups g ON g.slot_id = s.id
    WHERE s.event_id = ? ORDER BY s.date, s.start_time, s.sort_order, s.id, g.id
  `).bind(id).all();
  const header = ['Date', 'Start', 'End', 'Task', 'Capacity', 'First name', 'Last name', 'Email', 'Mobile', 'Comments', 'Signed up (UTC)'];
  const lines = [header, ...results.map(r => [
    r.date, r.start_time, r.end_time, r.task, r.capacity,
    r.first_name || '(open)', r.last_name || '', r.email || '', r.mobile || '', r.comments || '', r.created_at || '',
  ])].map(row => row.map(csvCell).join(','));
  const filename = `${ev.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'event'}-volunteers.csv`;
  return new Response('\uFEFF' + lines.join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` },
  });
}

async function adminEmailVolunteers(request, env, ctx, id) {
  const body = await readJson(request);
  const subject = req(body.subject, 'Subject', 200);
  const message = req(body.message, 'Message', 10000);
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!ev) throw httpError(404, 'Event not found.');
  const slotFilter = Array.isArray(body.slot_ids) && body.slot_ids.length ? body.slot_ids.map(Number).filter(Number.isInteger) : null;
  const { results } = await env.DB.prepare(`
    SELECT g.email, g.first_name, g.manage_token, s.id AS slot_id FROM signups g JOIN slots s ON s.id = g.slot_id
    WHERE s.event_id = ? ORDER BY g.id`).bind(id).all();
  const people = new Map();
  for (const r of results) {
    if (slotFilter && !slotFilter.includes(r.slot_id)) continue;
    const key = r.email.toLowerCase();
    if (!people.has(key)) people.set(key, r);
  }
  for (const p of people.values()) {
    const html = emailLayout(env, `
      <p>Hi ${esc(p.first_name)},</p>
      ${paragraphs(message)}
      <p style="color:#555;font-size:14px">You are receiving this because you signed up to help at <strong>${esc(ev.title)}</strong>.
      <a href="${manageUrl(env, p.manage_token)}">View or change your sign-up</a>.</p>`);
    await enqueue(env, p.email, subject, html, null, ev.contact_email || null);
  }
  ctx.waitUntil(processQueue(env));
  const status = await (await adminStatus(env)).json();
  return json({ ok: true, queued: people.size, status });
}

async function adminAddSignup(request, env, ctx) {
  const body = await readJson(request);
  const person = validatePerson(body);
  const slotId = Number(body.slot_id);
  const slot = await env.DB.prepare(`SELECT * FROM slots WHERE id = ?`).bind(slotId).first();
  if (!slot) throw httpError(404, 'Slot not found.');
  const dup = await env.DB.prepare(`SELECT id FROM signups WHERE slot_id = ? AND lower(email) = lower(?)`).bind(slotId, person.email).first();
  if (dup) throw httpError(400, 'That email is already signed up for this slot.');
  const token = randomToken();
  const reminderCutoff = new Date(Date.now() + reminderHours(env) * 3600e3).toISOString();
  await env.DB.prepare(`
    INSERT INTO signups (slot_id, first_name, last_name, email, mobile, comments, manage_token, reminder_sent)
    VALUES (?,?,?,?,?,?,?,?)`).bind(slotId, person.first_name, person.last_name, person.email, person.mobile,
    person.comments, token, slot.start_utc <= reminderCutoff ? 1 : 0).run();
  if (body.send_email) { await queueConfirmation(env, token); ctx.waitUntil(processQueue(env)); }
  return adminGetEvent(env, slot.event_id);
}

async function adminRemoveSignup(env, id) {
  const row = await env.DB.prepare(`SELECT s.event_id FROM signups g JOIN slots s ON s.id = g.slot_id WHERE g.id = ?`).bind(id).first();
  if (!row) throw httpError(404, 'Sign-up not found.');
  await env.DB.prepare(`DELETE FROM signups WHERE id = ?`).bind(id).run();
  return adminGetEvent(env, row.event_id);
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

async function signupsForToken(env, token) {
  const { results } = await env.DB.prepare(`
    SELECT g.id, g.first_name, g.email, s.title, s.details, s.date, s.start_time, s.end_time, s.start_utc,
           e.id AS event_id, e.title AS event_title, e.location, e.contact_name, e.contact_email
    FROM signups g JOIN slots s ON s.id = g.slot_id JOIN events e ON e.id = s.event_id
    WHERE g.manage_token = ? ORDER BY s.date, s.start_time`).bind(token).all();
  return results;
}

async function queueConfirmation(env, token) {
  const rows = await signupsForToken(env, token);
  if (!rows.length) return;
  const first = rows[0];
  const eventTitles = [...new Set(rows.map(r => r.event_title))];
  const subject = `You're signed up: ${eventTitles.join(', ')}`;
  const html = emailLayout(env, `
    <p>Hi ${esc(first.first_name)},</p>
    <p>Thank you for volunteering! Here ${rows.length === 1 ? 'is your slot' : 'are your slots'}:</p>
    ${slotTable(rows)}
    <p>We'll send you a reminder the day before.</p>
    <p style="margin:24px 0"><a href="${manageUrl(env, token)}" style="background:#1f5f8b;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">View or cancel my sign-up</a></p>
    <p style="color:#555;font-size:14px">Keep this email: the button above is your private link to make changes. A calendar file is attached.</p>
    ${contactLine(first)}`);
  await enqueue(env, first.email, subject, html, buildIcs(env, rows), first.contact_email || null);
}

async function queueReminders(env) {
  const now = new Date();
  const until = new Date(now.getTime() + reminderHours(env) * 3600e3).toISOString();
  const { results } = await env.DB.prepare(`
    SELECT g.id, g.first_name, g.email, g.manage_token, s.title, s.details, s.date, s.start_time, s.end_time, s.start_utc,
           e.id AS event_id, e.title AS event_title, e.location, e.contact_name, e.contact_email
    FROM signups g JOIN slots s ON s.id = g.slot_id JOIN events e ON e.id = s.event_id
    WHERE g.reminder_sent = 0 AND s.start_utc > ? AND s.start_utc <= ?
    ORDER BY s.date, s.start_time`).bind(now.toISOString(), until).all();
  if (!results.length) return 0;
  // One reminder per person per event
  const groups = new Map();
  for (const r of results) {
    const key = r.email.toLowerCase() + '|' + r.event_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const rows of groups.values()) {
    const f = rows[0];
    const html = emailLayout(env, `
      <p>Hi ${esc(f.first_name)},</p>
      <p>Just a friendly reminder that you're helping at <strong>${esc(f.event_title)}</strong> soon:</p>
      ${slotTable(rows)}
      <p>Thank you, we couldn't do it without you!</p>
      <p style="color:#555;font-size:14px">Can't make it any more? Please <a href="${manageUrl(env, f.manage_token)}">cancel your slot</a> so someone else can take it.</p>
      ${contactLine(f)}`);
    await enqueue(env, f.email, `Reminder: ${f.event_title}`, html, null, f.contact_email || null);
  }
  await env.DB.batch(results.map(r => env.DB.prepare(`UPDATE signups SET reminder_sent = 1 WHERE id = ?`).bind(r.id)));
  return groups.size;
}

async function enqueue(env, to, subject, html, ics, replyTo) {
  await env.DB.prepare(`INSERT INTO email_queue (to_email, subject, html, ics, reply_to) VALUES (?,?,?,?,?)`)
    .bind(to, subject, html, ics, replyTo).run();
}

async function processQueue(env) {
  const limit = dailyLimit(env);
  const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM email_queue WHERE status = 'sent' AND sent_at > datetime('now', '-1 day')`).first();
  const allowance = Math.min(limit - n, 50);
  if (allowance <= 0) return;
  const { results } = await env.DB.prepare(`SELECT * FROM email_queue WHERE status = 'queued' ORDER BY id LIMIT ?`).bind(allowance).all();
  for (const msg of results) {
    // Claim the row first so overlapping runs never double-send
    const claim = await env.DB.prepare(`UPDATE email_queue SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'`).bind(msg.id).run();
    if (!claim.meta.changes) continue;
    try {
      await sendEmail(env, msg);
      await env.DB.prepare(`UPDATE email_queue SET status = 'sent', sent_at = datetime('now'), last_error = NULL WHERE id = ?`).bind(msg.id).run();
    } catch (err) {
      const status = msg.attempts + 1 >= 5 ? 'failed' : 'queued';
      await env.DB.prepare(`UPDATE email_queue SET status = ?, last_error = ? WHERE id = ?`).bind(status, String(err.message || err).slice(0, 500), msg.id).run();
      if (/5\.7\.236|daily limit/i.test(String(err.message))) break; // Microsoft daily cap hit; try again next hour
    }
  }
}

let graphToken = null;
async function sendEmail(env, msg) {
  if ((env.EMAIL_MODE || 'log') !== 'graph') {
    console.log(`[email:log] to=${msg.to_email} subject=${msg.subject}`);
    return;
  }
  if (!graphToken || graphToken.exp < Date.now() + 60e3) {
    const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Microsoft login failed: ${data.error_description || data.error || res.status}`);
    graphToken = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  }
  const message = {
    subject: msg.subject,
    body: { contentType: 'HTML', content: msg.html },
    toRecipients: [{ emailAddress: { address: msg.to_email } }],
  };
  if (msg.reply_to) message.replyTo = [{ emailAddress: { address: msg.reply_to } }];
  if (msg.ics) message.attachments = [{
    '@odata.type': '#microsoft.graph.fileAttachment', name: 'volunteer-slot.ics',
    contentType: 'text/calendar', contentBytes: btoa(unescape(encodeURIComponent(msg.ics))),
  }];
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MS_SENDER)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${graphToken.value}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new Error(`Send failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

async function runHourly(env) {
  await queueReminders(env);
  // Sign-ups stuck mid-send (e.g. worker stopped) go back in the queue
  await env.DB.prepare(`UPDATE email_queue SET status = 'queued' WHERE status = 'sending' AND created_at < datetime('now', '-30 minutes')`).run();
  await processQueue(env);
  await env.DB.prepare(`DELETE FROM login_attempts WHERE at < datetime('now', '-1 day')`).run();
  await env.DB.prepare(`DELETE FROM email_queue WHERE status = 'sent' AND sent_at < datetime('now', '-60 days')`).run();
}

function emailLayout(env, inner) {
  const org = esc(env.ORG_NAME || 'P&C');
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2733">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="font-weight:bold;color:#1f5f8b;font-size:18px;margin-bottom:12px">${org} Volunteers</div>
    <div style="background:#fff;border-radius:12px;padding:20px 22px;line-height:1.5;font-size:16px">${inner}</div>
    <div style="color:#888;font-size:12px;margin-top:12px;text-align:center">${org}</div>
  </div></body></html>`;
}

function slotTable(rows) {
  return rows.map(r => `
    <div style="border-left:4px solid #1f5f8b;padding:8px 12px;margin:10px 0;background:#f4f8fb;border-radius:4px">
      <div style="font-weight:bold">${esc(r.title)}</div>
      <div>${esc(fmtDate(r.date))}, ${esc(fmtTime(r.start_time))} to ${esc(fmtTime(r.end_time))}</div>
      <div style="color:#555">${esc(r.event_title)}${r.location ? ' &middot; ' + esc(r.location) : ''}</div>
      ${r.details ? `<div style="color:#555;font-size:14px;margin-top:4px">${esc(r.details).replace(/\n/g, '<br>')}</div>` : ''}
    </div>`).join('');
}

function contactLine(r) {
  if (!r.contact_email && !r.contact_name) return '';
  const who = esc(r.contact_name || r.contact_email);
  return `<p style="color:#555;font-size:14px">Questions? Contact ${r.contact_email ? `<a href="mailto:${esc(r.contact_email)}">${who}</a>` : who}.</p>`;
}

function buildIcs(env, rows) {
  const tz = timezone(env);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const events = rows.map(r => [
    'BEGIN:VEVENT',
    `UID:pnc-signup-${r.id}@volunteers`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmt(localToUtc(r.date, r.start_time, tz))}`,
    `DTEND:${fmt(localToUtc(r.date, r.end_time, tz))}`,
    `SUMMARY:${icsEsc(`${r.event_title}: ${r.title}`)}`,
    `LOCATION:${icsEsc(r.location)}`,
    `DESCRIPTION:${icsEsc(r.details)}`,
    'END:VEVENT',
  ].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PnC Volunteers//EN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].join('\r\n');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function validatePerson(body) {
  const first_name = req(body.first_name, 'First name', 60);
  const last_name = req(body.last_name, 'Last name', 60);
  const email = req(body.email, 'Email', 200).toLowerCase();
  if (!isEmail(email)) throw httpError(400, 'Please check your email address.');
  const digits = String(body.mobile || '').replace(/[\s\-().]/g, '');
  let mobile;
  if (/^04\d{8}$/.test(digits)) mobile = digits;
  else if (/^\+?614\d{8}$/.test(digits)) mobile = '0' + digits.replace(/^\+?61/, '');
  else throw httpError(400, 'Please enter an Australian mobile number, e.g. 0412 345 678.');
  mobile = `${mobile.slice(0, 4)} ${mobile.slice(4, 7)} ${mobile.slice(7)}`;
  const comments = opt(body.comments, 1000);
  return { first_name, last_name, email, mobile, comments };
}

function req(v, label, max) {
  const s = String(v ?? '').trim();
  if (!s) throw httpError(400, `${label} is required.`);
  if (s.length > max) throw httpError(400, `${label} is too long.`);
  return s;
}
function opt(v, max) { return String(v ?? '').trim().slice(0, max); }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }
function displayName(first, last) { return `${first} ${last ? last[0].toUpperCase() + '.' : ''}`.trim(); }
function csvCell(v) { const s = String(v ?? ''); return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function paragraphs(text) { return String(text).split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''); }
function manageUrl(env, token) { return `${(env.SITE_URL || '').replace(/\/$/, '')}/manage.html?t=${token}`; }
function timezone(env) { return env.TIMEZONE || 'Australia/Sydney'; }
function dailyLimit(env) { return parseInt(env.DAILY_EMAIL_LIMIT, 10) || 90; }
function reminderHours(env) { return parseInt(env.REMINDER_HOURS, 10) || 24; }

function fmtDate(d) {
  const dt = new Date(d + 'T12:00:00Z');
  return dt.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function fmtTime(t) {
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')}${ap}`;
}
function addDays(date, days) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Convert a wall-clock date/time in `tz` to a UTC Date (handles daylight saving). */
function localToUtc(date, time, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc - tzOffset(asUtc, tz);
  guess = asUtc - tzOffset(guess, tz);
  return new Date(guess);
}
function tzOffset(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));
  const g = t => +parts.find(p => p.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ts / 1000) * 1000;
}

function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return b64urlBytes(b);
}
function b64url(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function b64urlBytes(bytes) { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
async function safeEqual(a, b) {
  // Compare digests so timing does not leak the password
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ax.length; i++) diff |= ax[i] ^ by[i];
  return diff === 0;
}

async function readJson(request) {
  try { return await request.json(); } catch { throw httpError(400, 'Invalid request.'); }
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
