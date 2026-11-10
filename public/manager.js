// Manager dashboard: live fleet board, tickets, batteries, alert log, reports
// and setup (lifts, people, alert rules, settings).
import { api, CHANNEL_ICON, duration, fmtDateTime, html, mount, timeAgo, toast } from './common.js';
import { beep, createScanner, nfcSupported } from './scan.js';

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $logout = document.getElementById('logout');

let cfg;
let delivery = {};
let refreshTimer;
let setupSection = 'rules';
let ticketFilter = 'open';
let reportDays = 30;
let scanner;
let tagDraft = { kind: 'lift', ref: '', write: true };

const byKey = (list) => Object.fromEntries((list ?? []).map((x) => [x.key, x]));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_LABEL = { down: 'Down', repair: 'Needs repair', available: 'OK' };
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

// ---------------- boot / auth ----------------
async function init() {
  cfg = await api('GET', '/api/config');
  document.getElementById('siteName').textContent = `· ${cfg.siteName} · Manager`;
  const s = await api('GET', '/api/manager/session');
  delivery = s.delivery ?? {};
  if (s.protected && !s.loggedIn) return showLogin();
  start(s.protected);
}

function showLogin() {
  clearInterval(refreshTimer);
  $tabs.classList.add('hidden');
  $logout.classList.add('hidden');
  mount(
    $view,
    html`<form class="card stack login" id="login">
      <h1>Manager login</h1>
      <label class="field"><span>PIN</span>
        <input type="password" id="pin" inputmode="numeric" autocomplete="current-password" autofocus />
      </label>
      <button class="btn primary" type="submit">Log in</button>
      <p class="center small"><a href="/">← Back to reporting</a></p>
    </form>`,
  );
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/manager/login', { pin: document.getElementById('pin').value });
      const s = await api('GET', '/api/manager/session');
      delivery = s.delivery ?? {};
      start(true);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}

function start(isProtected) {
  $tabs.classList.remove('hidden');
  $logout.classList.toggle('hidden', !isProtected);
  $logout.onclick = async () => {
    await api('POST', '/api/manager/logout');
    showLogin();
  };
  scanner ??= createScanner({ onScan: null });
  window.onhashchange = route;
  route();
}

const TABS = { board, tickets, battery, alerts, reports, setup };

async function route() {
  clearInterval(refreshTimer);
  scanner?.setHandler(null);
  const tab = location.hash.slice(1) in TABS ? location.hash.slice(1) : 'board';
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${tab}`));
  await show(TABS[tab]);
}

async function show(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401) return showLogin();
    mount($view, html`<div class="banner down">${err.message}</div>`);
  }
}

function autoRefresh(fn, ms = 20_000) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !document.activeElement?.matches('input, textarea, select')) show(fn);
  }, ms);
}

// ---------------- shared bits ----------------
const sevChip = (t) => html`<span class="chip ${t.severity === 'down' ? 'down' : 'repair'}">${t.severityLabel}</span>`;

function ticketTable(list, { empty = 'Nothing here.' } = {}) {
  if (!list.length) return html`<div class="card muted">${empty}</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Lift</th><th>Problem</th><th>Severity</th><th>Status</th><th>Reported</th><th>Open for</th><th>Assigned</th></tr></thead>
    <tbody>
      ${list.map(
        (t) => html`<tr class="clickable" data-ticket="${t.id}">
          <td>${t.id}</td>
          <td><strong>${t.unit}</strong><div class="muted small">${t.liftTypeLabel}</div></td>
          <td>${t.categoryLabel}${t.errorCode ? html`<div class="muted small">Code ${t.errorCode}</div>` : ''}
            ${t.description ? html`<div class="small">“${t.description.length > 90 ? t.description.slice(0, 89) + '…' : t.description}”</div>` : ''}</td>
          <td>${sevChip(t)}</td>
          <td>${t.statusLabel}${t.escalatedAt && !t.acknowledgedAt ? html` <span title="Escalated">⏰</span>` : ''}</td>
          <td>${t.reportedBy}<div class="muted small">${fmtDateTime(t.createdAt)}</div></td>
          <td class="num">${duration(t.createdAt, t.resolvedAt)}</td>
          <td>${t.assignedTo || html`<span class="muted">—</span>`}</td>
        </tr>`,
      )}
    </tbody></table></div>`;
}

function wireTicketLinks() {
  $view.querySelectorAll('[data-ticket]').forEach((row) => {
    row.onclick = () => {
      location.href = `/t/${row.dataset.ticket}`;
    };
  });
}

function chargeBar(pct, low) {
  if (pct == null) return html`<span class="muted">—</span>`;
  const color = pct <= low ? 'var(--down)' : pct <= 40 ? 'var(--repair)' : 'var(--ok)';
  return html`<div class="row" style="flex-wrap:nowrap"><div class="bar" style="flex:1"><div style="width:${pct}%;background:${color}"></div></div><strong>${pct}%</strong></div>`;
}

const checks = (name, options, selected = []) =>
  html`<div class="check-group">${options.map(
    (o) => html`<label><input type="checkbox" name="${name}" value="${o.key}" ${selected.includes(o.key) ? 'checked' : ''} /> ${o.label}</label>`,
  )}</div>`;

const checked = (form, name, asNumber = false) =>
  [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => (asNumber ? Number(i.value) : i.value));

// ---------------- Fleet board ----------------
async function board() {
  const d = await api('GET', '/api/manager/board');
  const types = cfg.liftTypes;
  const low = d.settings.lowChargePct;
  mount(
    $view,
    html`<div class="stack">
      ${setupWarnings()}
      <div class="stats">
        <div class="stat down"><div class="n">${d.counts.down}</div><div class="l">Down</div></div>
        <div class="stat repair"><div class="n">${d.counts.repair}</div><div class="l">Needs repair</div></div>
        <div class="stat available"><div class="n">${d.counts.available}</div><div class="l">Available</div></div>
        ${types
          .filter((t) => d.byType[t.key])
          .map(
            (t) => html`<div class="stat"><div class="n">${d.byType[t.key].available}/${d.byType[t.key].total}</div>
              <div class="l">${t.label}s ready</div></div>`,
          )}
      </div>

      <h2 style="margin-top:8px">Open problems (${d.tickets.length})</h2>
      ${ticketTable(d.tickets, { empty: '✅ No open problems. Every lift is good to go.' })}

      ${types.map((t) => {
        const lifts = d.lifts.filter((l) => l.type === t.key);
        if (!lifts.length) return '';
        return html`<h2 style="margin-top:8px">${t.label}s</h2>
          <div class="board">
            ${lifts.map(
              (l) => html`<div class="lift-card ${l.status}">
                <div class="row" style="flex-wrap:nowrap"><span class="u">${l.unit}</span><span class="spacer"></span>
                  <span class="chip ${l.status}">${STATUS_LABEL[l.status]}</span></div>
                <div class="s">${l.zone || ' '}</div>
                ${l.status === 'down' ? html`<div class="s" style="color:var(--down);font-weight:700">Down ${duration(l.downSince)}</div>` : ''}
                ${l.openCount ? html`<div class="s">${l.openCount} open issue${l.openCount > 1 ? 's' : ''}</div>` : ''}
                ${l.lastCharge
                  ? html`<div class="s" style="${l.lastCharge.pct <= low ? 'color:var(--down);font-weight:700' : ''}">🔋 ${l.lastCharge.pct}% · ${timeAgo(l.lastCharge.at)}</div>`
                  : ''}
              </div>`,
            )}
          </div>`;
      })}
      <p class="muted small">Updates automatically every 20 seconds.</p>
    </div>`,
  );
  wireTicketLinks();
  autoRefresh(board);
}

function setupWarnings() {
  const notes = [];
  if (!delivery.email) notes.push('email');
  if (!delivery.sms) notes.push('text messages');
  if (!notes.length && delivery.publicUrl) return '';
  return html`<div class="banner info small">
    ${notes.length ? html`⚙️ Server is not set up to send ${notes.join(' or ')} yet — those alerts are only recorded in the Alert log. ` : ''}
    ${!delivery.publicUrl ? html`⚙️ PUBLIC_URL is not set, so alerts won't include a link to the ticket. ` : ''}
    See the README for the environment variables.
  </div>`;
}

// ---------------- Tickets ----------------
async function tickets() {
  const list = await api('GET', `/api/manager/tickets?status=${ticketFilter}&limit=500`);
  mount(
    $view,
    html`<div class="row" style="margin-bottom:12px">
        <div class="subnav" style="margin:0">
          ${['open', 'resolved', 'all'].map(
            (f) => html`<button class="btn small ${ticketFilter === f ? 'active' : ''}" type="button" data-filter="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`,
          )}
        </div>
        <span class="spacer"></span>
        <a class="btn small" href="/api/manager/export/tickets.csv">⬇️ Export CSV</a>
      </div>
      ${ticketTable(list)}`,
  );
  $view.querySelectorAll('[data-filter]').forEach((b) => {
    b.onclick = () => {
      ticketFilter = b.dataset.filter;
      show(tickets);
    };
  });
  wireTicketLinks();
  autoRefresh(tickets, 30_000);
}

// ---------------- Batteries ----------------
async function battery() {
  const d = await api('GET', '/api/manager/battery');
  const low = d.settings.lowChargePct;
  const types = byKey(cfg.liftTypes);
  mount(
    $view,
    html`<div class="stack">
      <h2>Charge by lift</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Lift</th><th>Type</th><th style="min-width:160px">Last charge</th><th>Battery in lift</th><th>Last change</th><th class="num">Changes 24h</th><th class="num">Changes 7d</th></tr></thead>
        <tbody>
          ${d.summary.map(
            (s) => html`<tr>
              <td><strong>${s.unit}</strong> ${s.status !== 'available' ? html`<span class="chip ${s.status}">${STATUS_LABEL[s.status]}</span>` : ''}</td>
              <td>${types[s.type]?.short ?? s.type}${s.power === 'lithium' ? html` <span class="muted small">Li-ion</span>` : ''}</td>
              <td>${chargeBar(s.lastCharge?.pct, low)}<div class="muted small">${s.lastCharge ? timeAgo(s.lastCharge.at) : ''}</div></td>
              <td>${s.currentBattery || html`<span class="muted">—</span>`}</td>
              <td>${s.lastChangeAt ? timeAgo(s.lastChangeAt) : html`<span class="muted">—</span>`}</td>
              <td class="num">${s.changes24h >= 3 ? html`<strong style="color:var(--down)" title="Frequent swaps can mean a weak battery">⚠️ ${s.changes24h}</strong>` : s.changes24h}</td>
              <td class="num">${s.changes7d}</td>
            </tr>`,
          )}
        </tbody></table></div>
      <p class="muted small">⚠️ = 3+ swaps in 24 hours. That usually means a weak battery or one that wasn't fully charged.</p>

      <div class="grid-2">
        <div>
          <h2>Where is each battery?</h2>
          ${d.inventory.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>Battery</th><th>Last seen</th><th>Charge</th><th>When</th></tr></thead>
                <tbody>${d.inventory.map(
                  (b) => html`<tr><td><strong>${b.battery}</strong></td>
                    <td>${b.state === 'in_lift' ? html`In <strong>${b.unit}</strong>` : html`Out of ${b.unit} <span class="muted">(charging?)</span>`}</td>
                    <td>${b.chargePct != null ? `${b.chargePct}%` : '—'}</td><td>${timeAgo(b.at)}</td></tr>`,
                )}</tbody></table></div>`
            : html`<div class="card muted">Battery numbers show up here once workers log battery changes.</div>`}
        </div>
        <div>
          <h2>Recent battery activity</h2>
          ${d.events.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>When</th><th>Lift</th><th>What</th><th>By</th></tr></thead>
                <tbody>${d.events.map(
                  (e) => html`<tr><td>${fmtDateTime(e.createdAt)}</td><td><strong>${e.unit}</strong></td>
                    <td>${e.kind === 'change'
                      ? html`🔋 Swap: ${e.batteryOut || '?'}${e.outChargePct != null ? ` (${e.outChargePct}%)` : ''} → ${e.batteryIn || '?'}${e.chargePct != null ? ` (${e.chargePct}%)` : ''}`
                      : html`⚡ Charge <strong style="${e.chargePct <= low ? 'color:var(--down)' : ''}">${e.chargePct}%</strong>`}
                      ${e.hourMeter != null ? html`<div class="muted small">Hours ${e.hourMeter}</div>` : ''}</td>
                    <td>${e.reportedBy}</td></tr>`,
                )}</tbody></table></div>`
            : html`<div class="card muted">No battery changes or charge readings yet.</div>`}
        </div>
      </div>
    </div>`,
  );
  autoRefresh(battery, 30_000);
}

// ---------------- Alert log ----------------
async function alerts() {
  const list = await api('GET', '/api/manager/notifications?limit=300');
  const events = byKey(cfg.eventTypes);
  mount(
    $view,
    html`<div class="stack">
      ${setupWarnings()}
      <p class="muted">Every alert the system sent or tried to send. <strong>Skipped</strong> = that person has no phone/email/webhook on file. <strong>Logged</strong> = that channel isn't set up on the server yet.</p>
      ${list.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Event</th><th>To</th><th>How</th><th>Status</th><th>Message</th></tr></thead>
            <tbody>${list.map(
              (n) => html`<tr class="${n.refType === 'ticket' ? 'clickable' : ''}" ${n.refType === 'ticket' ? html`data-ticket="${n.refId}"` : ''}>
                <td>${fmtDateTime(n.createdAt)}</td>
                <td>${n.eventType === 'test' ? 'Test' : (events[n.eventType]?.label ?? n.eventType)}</td>
                <td><strong>${n.contactName}</strong><div class="muted small">${n.destination}</div></td>
                <td>${CHANNEL_ICON[n.channel] ?? ''} ${n.channel}</td>
                <td class="status-${n.status}">${n.status}${n.error ? html`<div class="small muted">${n.error}</div>` : ''}</td>
                <td class="small">${n.subject}</td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<div class="card muted">No alerts yet.</div>`}
    </div>`,
  );
  wireTicketLinks();
  autoRefresh(alerts, 30_000);
}

// ---------------- Reports ----------------
async function reports() {
  const s = await api('GET', `/api/manager/stats?days=${reportDays}`);
  const rows = [...cfg.liftTypes.map((t) => ({ key: t.key, label: t.label })), { key: 'all', label: 'All lifts' }];
  const m = (v) => (v == null ? '—' : v < 60 ? `${v} min` : `${Math.floor(v / 60)}h ${v % 60}m`);
  mount(
    $view,
    html`<div class="stack">
      <div class="row">
        <h2 style="margin:0">Last ${reportDays} days</h2><span class="spacer"></span>
        <div class="subnav" style="margin:0">${[7, 30, 90].map(
          (n) => html`<button class="btn small ${reportDays === n ? 'active' : ''}" type="button" data-days="${n}">${n} days</button>`,
        )}</div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Lift type</th><th class="num">Problems</th><th class="num">Down</th><th class="num">Still open</th>
          <th class="num">Avg time to acknowledge</th><th class="num">Avg time to fix</th><th class="num">Down hours</th><th>Top problems</th></tr></thead>
        <tbody>${rows.map((r) => {
          const x = s.byLiftType[r.key];
          if (!x) return html`<tr><td><strong>${r.label}</strong></td><td class="num" colspan="6">0</td><td></td></tr>`;
          return html`<tr${r.key === 'all' ? html` style="font-weight:700"` : ''}>
            <td><strong>${r.label}</strong></td><td class="num">${x.tickets}</td><td class="num">${x.down}</td><td class="num">${x.open}</td>
            <td class="num">${m(x.avgMinutesToAcknowledge)}</td><td class="num">${m(x.avgMinutesToResolve)}</td><td class="num">${x.downHours}</td>
            <td class="small">${x.topCategories.map((c) => `${c.label} (${c.count})`).join(', ')}</td></tr>`;
        })}</tbody></table></div>
      <p class="muted small">Down hours = total time lifts spent tagged out. Compare your Raymond and Linde fleets and dealer response times here.
        <a href="/api/manager/export/tickets.csv">Export every ticket as CSV</a> for deeper analysis.</p>
    </div>`,
  );
  $view.querySelectorAll('[data-days]').forEach((b) => {
    b.onclick = () => {
      reportDays = Number(b.dataset.days);
      show(reports);
    };
  });
}

// ---------------- Setup ----------------
async function setup() {
  const sections = { rules: 'Alert rules', people: 'People', lifts: 'Lifts & QR labels', tags: 'NFC tags', settings: 'Settings' };
  mount(
    $view,
    html`<div class="subnav">${Object.entries(sections).map(
        ([k, label]) => html`<button class="btn small ${setupSection === k ? 'active' : ''}" type="button" data-section="${k}">${label}</button>`,
      )}</div>
      <div id="section"></div>`,
  );
  $view.querySelectorAll('[data-section]').forEach((b) => {
    b.onclick = () => {
      scanner?.setHandler(null);
      setupSection = b.dataset.section;
      show(setup);
    };
  });
  await { rules: rulesSection, people: peopleSection, lifts: liftsSection, tags: tagsSection, settings: settingsSection }[setupSection]();
}

const $section = () => document.getElementById('section');

// ----- rules -----
function ruleSentence(r, contacts) {
  const ev = byKey(cfg.eventTypes);
  const lt = byKey(cfg.liftTypes);
  const ct = byKey(cfg.categories);
  const sv = byKey(cfg.severities);
  const ch = byKey(cfg.channels);
  const list = (keys, map, fallback, joiner = ' or ') =>
    keys.length ? html`<b>${keys.map((k) => map[k]?.short ?? map[k]?.label ?? k).join(joiner)}</b>` : html`<b>${fallback}</b>`;
  const channels = ['sms', 'email', 'webhook'].filter((c) => r.channels.includes(c));
  const people = r.contactIds.map((id) => contacts.find((c) => c.id === id)?.name ?? `#${id}`);
  const when = [];
  if (r.days.length && r.days.length < 7) when.push(r.days.map((d) => DAYS[d]).join(', '));
  if (r.timeStart && r.timeEnd) when.push(`${r.timeStart}–${r.timeEnd}`);
  return html`When ${list(r.eventTypes, ev, 'anything happens')} on ${list(r.liftTypes, lt, 'any lift')}
    ${r.categories.length ? html` for ${list(r.categories, ct)}` : ''}
    ${r.severities.length ? html` that is ${list(r.severities, sv)}` : ''}
    ${when.length ? html` during <b>${when.join(' ')}</b>` : ''}
    → ${list(channels, ch, '', ' + ')} to <b>${people.join(', ') || 'nobody'}</b>`;
}

async function rulesSection() {
  const [rules, contacts] = await Promise.all([api('GET', '/api/manager/rules'), api('GET', '/api/manager/contacts')]);
  const opt = (list, any) => html`<option value="">${any}</option>${list.map((x) => html`<option value="${x.key}">${x.label}</option>`)}`;
  mount(
    $section(),
    html`<div class="grid-2">
      <div class="stack">
        <div class="row"><h2 style="margin:0">Alert rules</h2><span class="spacer"></span>
          <button class="btn small primary" type="button" id="newRule">＋ New rule</button></div>
        <p class="muted small" style="margin:0">Every rule that matches fires. If several rules match the same person, they still get just one alert on each channel.</p>
        ${rules.map(
          (r) => html`<div class="card rule ${r.enabled ? '' : 'off'}">
            <label class="switch" title="On/off"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} /><span></span></label>
            <div class="sentence"><strong>${r.name}</strong><div class="small" style="margin-top:4px">${ruleSentence(r, contacts)}</div></div>
            <button class="btn small" type="button" data-edit="${r.id}">Edit</button>
          </div>`,
        )}
      </div>
      <div>
        <form class="card stack" id="preview" style="position:sticky;top:120px">
          <h2 style="margin:0">🔎 Who gets alerted if…</h2>
          <div class="form-grid">
            <label class="field"><span>Event</span><select name="eventType">${cfg.eventTypes.map((e) => html`<option value="${e.key}">${e.label}</option>`)}</select></label>
            <label class="field"><span>Lift type</span><select name="liftType">${opt(cfg.liftTypes, '—')}</select></label>
            <label class="field"><span>Problem</span><select name="category">${opt(cfg.categories, '—')}</select></label>
            <label class="field"><span>Severity</span><select name="severity">${opt(cfg.severities.map((s) => ({ ...s, label: s.short })), '—')}</select></label>
          </div>
          <div id="previewOut"></div>
        </form>
      </div>
    </div>`,
  );
  document.getElementById('newRule').onclick = () => ruleEditor(null, contacts);
  $section().querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => ruleEditor(rules.find((r) => r.id === Number(b.dataset.edit)), contacts);
  });
  $section().querySelectorAll('[data-toggle]').forEach((input) => {
    input.onchange = async () => {
      const r = rules.find((x) => x.id === Number(input.dataset.toggle));
      try {
        await api('PUT', `/api/manager/rules/${r.id}`, { ...r, enabled: input.checked });
        r.enabled = input.checked;
        input.closest('.rule').classList.toggle('off', !input.checked);
        runPreview();
      } catch (err) {
        toast(err.message, { error: true });
        input.checked = !input.checked;
      }
    };
  });
  const form = document.getElementById('preview');
  async function runPreview() {
    const body = Object.fromEntries(new FormData(form));
    const out = await api('POST', '/api/manager/rules/preview', body);
    mount(
      document.getElementById('previewOut'),
      out.length
        ? html`<ul class="timeline">${out.map(
            (p) => html`<li><strong>${p.contact.name}</strong> ${p.channels.map((c) => CHANNEL_ICON[c]).join(' ')}
              <div class="muted small">via ${p.rules.map((r) => r.name).join('; ')}</div></li>`,
          )}</ul>`
        : html`<div class="banner warn">Nobody would be alerted.</div>`,
    );
  }
  form.onchange = () => runPreview().catch((err) => toast(err.message, { error: true }));
  form.onsubmit = (e) => e.preventDefault();
  await runPreview();
}

function ruleEditor(rule, contacts) {
  const r = rule ?? {
    name: '',
    enabled: true,
    eventTypes: ['issue_reported'],
    liftTypes: [],
    categories: [],
    severities: [],
    days: [],
    timeStart: '',
    timeEnd: '',
    contactIds: [],
    channels: ['sms'],
  };
  mount(
    $section(),
    html`<form class="card stack" id="ruleForm" novalidate style="max-width:900px">
      <h2 style="margin:0">${rule ? 'Edit rule' : 'New alert rule'}</h2>
      <label class="field"><span>Rule name</span>
        <input type="text" name="name" value="${r.name}" placeholder="e.g. Linde DOWN on 2nd shift → night tech" maxlength="120" required /></label>
      <fieldset><legend>When this happens <em>(none ticked = anything)</em></legend>${checks('eventTypes', cfg.eventTypes, r.eventTypes)}</fieldset>
      <fieldset><legend>On these lift types <em>(none = any lift)</em></legend>${checks('liftTypes', cfg.liftTypes, r.liftTypes)}</fieldset>
      <fieldset><legend>For these problems <em>(none = any problem)</em></legend>
        ${checks('categories', cfg.categories.map((c) => ({ key: c.key, label: `${c.icon} ${c.label}` })), r.categories)}
        <p class="muted small" style="margin:8px 0 0">Ticking problems or severity means battery-change and low-charge events won't match this rule.</p></fieldset>
      <fieldset><legend>Severity <em>(none = either)</em></legend>${checks('severities', cfg.severities, r.severities)}</fieldset>
      <fieldset><legend>Only during this shift <em>(optional)</em></legend>
        ${checks('days', DAYS.map((d, i) => ({ key: String(i), label: d })), r.days.map(String))}
        <div class="form-grid" style="margin-top:10px">
          <label class="field"><span>From</span><input type="time" name="timeStart" value="${r.timeStart}" /></label>
          <label class="field"><span>To</span><input type="time" name="timeEnd" value="${r.timeEnd}" /></label>
        </div>
        <p class="muted small" style="margin:8px 0 0">Overnight shifts work (e.g. 22:00 → 06:00). Leave times empty for all day.</p></fieldset>
      <fieldset><legend>Alert these people</legend>
        ${contacts.length
          ? checks('contactIds', contacts.map((c) => ({ key: String(c.id), label: `${c.name}${c.role ? ` (${c.role})` : ''}` })), r.contactIds.map(String))
          : html`<p class="muted">Add people under Setup → People first.</p>`}</fieldset>
      <fieldset><legend>By</legend>${checks('channels', cfg.channels, r.channels)}</fieldset>
      <label class="row" style="gap:8px"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''} style="width:20px;height:20px" /> <strong>Rule is on</strong></label>
      <div class="row">
        <button class="btn primary small" type="submit">💾 Save rule</button>
        <button class="btn small" type="button" id="cancel">Cancel</button>
        <span class="spacer"></span>
        ${rule ? html`<button class="btn small danger" type="button" id="del">Delete</button>` : ''}
      </div>
    </form>`,
  );
  const form = document.getElementById('ruleForm');
  document.getElementById('cancel').onclick = () => show(rulesSection);
  document.getElementById('del')?.addEventListener('click', async () => {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    await api('DELETE', `/api/manager/rules/${rule.id}`);
    toast('Rule deleted');
    show(rulesSection);
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: form.elements.name.value,
      enabled: form.elements.enabled.checked,
      eventTypes: checked(form, 'eventTypes'),
      liftTypes: checked(form, 'liftTypes'),
      categories: checked(form, 'categories'),
      severities: checked(form, 'severities'),
      days: checked(form, 'days', true),
      timeStart: form.elements.timeStart.value,
      timeEnd: form.elements.timeEnd.value,
      contactIds: checked(form, 'contactIds', true),
      channels: checked(form, 'channels'),
    };
    try {
      await api(rule ? 'PUT' : 'POST', rule ? `/api/manager/rules/${rule.id}` : '/api/manager/rules', body);
      toast('✅ Rule saved');
      show(rulesSection);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}

// ----- people -----
async function peopleSection(editing) {
  const contacts = await api('GET', '/api/manager/contacts');
  const c = editing ?? { name: '', role: '', phone: '', email: '', webhookUrl: '', active: true };
  mount(
    $section(),
    html`<div class="grid-2">
      <div class="stack">
        <h2 style="margin:0">People & channels</h2>
        <p class="muted small" style="margin:0">Anyone who can get alerts: managers, techs, dealer service desks, or a Teams/Slack channel (use a webhook).</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Reach them by</th><th></th></tr></thead>
          <tbody>${contacts.map(
            (p) => html`<tr style="${p.active ? '' : 'opacity:.5'}">
              <td><strong>${p.name}</strong><div class="muted small">${p.role}${p.active ? '' : ' · inactive'}</div></td>
              <td class="small">${p.phone ? html`<div>📱 ${p.phone}</div>` : ''}${p.email ? html`<div>✉️ ${p.email}</div>` : ''}
                ${p.webhookUrl ? html`<div>💬 ${hostOf(p.webhookUrl)}</div>` : ''}
                ${!p.phone && !p.email && !p.webhookUrl ? html`<span class="status-skipped">⚠️ No contact info — alerts are skipped</span>` : ''}</td>
              <td style="white-space:nowrap"><button class="btn small" type="button" data-edit="${p.id}">Edit</button>
                <button class="btn small" type="button" data-test="${p.id}">Test</button></td>
            </tr>`,
          )}</tbody></table></div>
      </div>
      <form class="card stack" id="personForm" novalidate>
        <h2 style="margin:0">${editing ? `Edit ${editing.name}` : 'Add a person'}</h2>
        <div class="form-grid">
          <label class="field"><span>Name</span><input type="text" name="name" value="${c.name}" required /></label>
          <label class="field"><span>Role</span><input type="text" name="role" value="${c.role}" placeholder="e.g. 2nd shift supervisor" /></label>
          <label class="field"><span>Mobile (for texts)</span><input type="tel" name="phone" value="${c.phone}" placeholder="+15551234567" /></label>
          <label class="field"><span>Email</span><input type="email" name="email" value="${c.email}" /></label>
        </div>
        <label class="field"><span>Teams / Slack webhook URL <em>(optional)</em></span>
          <input type="url" name="webhookUrl" value="${c.webhookUrl}" placeholder="https://hooks.slack.com/… or Teams Workflows URL" /></label>
        <label class="row" style="gap:8px"><input type="checkbox" name="active" ${c.active ? 'checked' : ''} style="width:20px;height:20px" /> <strong>Active</strong> <span class="muted small">(untick for vacation or people who left)</span></label>
        <div class="row">
          <button class="btn primary small" type="submit">💾 Save</button>
          ${editing ? html`<button class="btn small" type="button" id="cancel">Cancel</button><span class="spacer"></span>
            <button class="btn small danger" type="button" id="del">Delete</button>` : ''}
        </div>
      </form>
    </div>`,
  );
  const form = document.getElementById('personForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: form.elements.name.value,
      role: form.elements.role.value,
      phone: form.elements.phone.value,
      email: form.elements.email.value,
      webhookUrl: form.elements.webhookUrl.value,
      active: form.elements.active.checked,
    };
    try {
      await api(editing ? 'PUT' : 'POST', editing ? `/api/manager/contacts/${editing.id}` : '/api/manager/contacts', body);
      toast('✅ Saved');
      show(() => peopleSection());
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  document.getElementById('cancel')?.addEventListener('click', () => show(() => peopleSection()));
  document.getElementById('del')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${editing.name}? They will be removed from every alert rule.`)) return;
    await api('DELETE', `/api/manager/contacts/${editing.id}`);
    toast('Deleted');
    show(() => peopleSection());
  });
  $section().querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => show(() => peopleSection(contacts.find((p) => p.id === Number(b.dataset.edit))));
  });
  $section().querySelectorAll('[data-test]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('POST', `/api/manager/contacts/${b.dataset.test}/test`);
        const summary = r.results.map((n) => `${n.channel}: ${n.status}${n.error ? ` (${n.error})` : ''}`).join(' · ');
        toast(`Test sent — ${summary}`, { ms: 8000 });
      } catch (err) {
        toast(err.message, { error: true });
      }
      b.disabled = false;
    };
  });
}

// ----- lifts -----
async function liftsSection(editing) {
  const lifts = await api('GET', '/api/manager/lifts');
  const types = byKey(cfg.liftTypes);
  const l = editing ?? { unit: '', type: cfg.liftTypes[0].key, model: '', serial: '', zone: '', power: 'lead_acid', active: true };
  mount(
    $section(),
    html`<div class="grid-2">
      <div class="stack">
        <div class="row"><h2 style="margin:0">Lifts (${lifts.filter((x) => x.active).length})</h2><span class="spacer"></span>
          <a class="btn small" href="/manager/labels" target="_blank" rel="noopener">🖨️ Print all QR labels</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Unit</th><th>Type</th><th>Zone</th><th>Model / serial</th><th></th></tr></thead>
          <tbody>${lifts.map(
            (x) => html`<tr style="${x.active ? '' : 'opacity:.5'}">
              <td><strong>${x.unit}</strong>${x.active ? '' : html`<div class="muted small">retired</div>`}</td>
              <td>${types[x.type]?.short ?? x.type}${x.power === 'lithium' ? html`<div class="muted small">Li-ion</div>` : ''}</td>
              <td>${x.zone}</td>
              <td class="small">${x.model}${x.serial ? html`<div class="muted">S/N ${x.serial}</div>` : ''}</td>
              <td style="white-space:nowrap"><button class="btn small" type="button" data-edit="${x.id}">Edit</button>
                <a class="btn small" href="/manager/labels?unit=${encodeURIComponent(x.unit)}" target="_blank" rel="noopener" title="QR label">QR</a></td>
            </tr>`,
          )}</tbody></table></div>
      </div>
      <form class="card stack" id="liftForm" novalidate>
        <h2 style="margin:0">${editing ? `Edit ${editing.unit}` : 'Add a lift'}</h2>
        <div class="form-grid">
          <label class="field"><span>Unit number</span><input type="text" name="unit" value="${l.unit}" placeholder="e.g. R-07" required /></label>
          <label class="field"><span>Type</span><select name="type">${cfg.liftTypes.map(
            (t) => html`<option value="${t.key}" ${t.key === l.type ? 'selected' : ''}>${t.label}</option>`,
          )}</select></label>
          <label class="field"><span>Zone / area</span><input type="text" name="zone" value="${l.zone}" placeholder="e.g. Aisles 1–12" /></label>
          <label class="field"><span>Battery</span><select name="power">${cfg.powerTypes.map(
            (p) => html`<option value="${p.key}" ${p.key === l.power ? 'selected' : ''}>${p.label}</option>`,
          )}</select></label>
          <label class="field"><span>Model</span><input type="text" name="model" value="${l.model}" /></label>
          <label class="field"><span>Serial number</span><input type="text" name="serial" value="${l.serial}" /></label>
        </div>
        ${editing ? html`<label class="row" style="gap:8px"><input type="checkbox" name="active" ${l.active ? 'checked' : ''} style="width:20px;height:20px" /> <strong>In the fleet</strong></label>` : ''}
        <div class="row">
          <button class="btn primary small" type="submit">💾 Save</button>
          ${editing ? html`<button class="btn small" type="button" id="cancel">Cancel</button><span class="spacer"></span>
            <button class="btn small danger" type="button" id="del">Remove</button>` : ''}
        </div>
      </form>
    </div>`,
  );
  const form = document.getElementById('liftForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      unit: form.elements.unit.value,
      type: form.elements.type.value,
      zone: form.elements.zone.value,
      power: form.elements.power.value,
      model: form.elements.model.value,
      serial: form.elements.serial.value,
      active: form.elements.active ? form.elements.active.checked : true,
    };
    try {
      await api(editing ? 'PUT' : 'POST', editing ? `/api/manager/lifts/${editing.id}` : '/api/manager/lifts', body);
      toast('✅ Saved');
      show(() => liftsSection());
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  document.getElementById('cancel')?.addEventListener('click', () => show(() => liftsSection()));
  document.getElementById('del')?.addEventListener('click', async () => {
    if (!confirm(`Remove ${editing.unit} from the fleet? Lifts with history are retired, not deleted.`)) return;
    const r = await api('DELETE', `/api/manager/lifts/${editing.id}`);
    toast(r.retired ? `${editing.unit} retired (history kept)` : `${editing.unit} deleted`);
    show(() => liftsSection());
  });
  $section().querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => show(() => liftsSection(lifts.find((x) => x.id === Number(b.dataset.edit))));
  });
}

// ----- NFC tags -----
const TAG_KINDS = [
  { key: 'lift', label: '🏷️ Lift' },
  { key: 'battery', label: '🔋 Battery' },
  { key: 'person', label: '🪪 Badge (person)' },
];

async function tagsSection() {
  const [tags, lifts] = await Promise.all([api('GET', '/api/manager/tags'), api('GET', '/api/manager/lifts')]);
  const active = lifts.filter((l) => l.active);
  const d = tagDraft;
  if (d.kind === 'lift' && !active.some((l) => l.unit === d.ref)) d.ref = active[0]?.unit ?? '';
  const base = delivery.publicUrl || location.origin;
  const linkFor = (kind, ref) => `${base}/${kind === 'lift' ? 'l' : 'b'}/${encodeURIComponent(ref)}`;
  const kindLabel = Object.fromEntries(TAG_KINDS.map((k) => [k.key, k.label]));

  mount(
    $section(),
    html`<div class="grid-2">
      <form class="card stack" id="tagForm" novalidate>
        <h2 style="margin:0">📶 Register NFC tags</h2>
        <p class="muted small" style="margin:0">Put an NFC sticker on each lift (use <strong>on-metal</strong> NTAG213/215 tags; normal tags won't read on steel), on each battery, or use badges.
          Open this page in <strong>Chrome on the Zebra device</strong>, pick what the tag is for, press <em>Tap tag now</em>, and hold the tag to the back of the device.</p>
        ${nfcSupported
          ? ''
          : html`<div class="banner info small">This browser can't read NFC. Open this page in Chrome on the Zebra device (or any Android phone with NFC).
              You can still type a tag's serial number below, or scan a barcode with the trigger.</div>`}
        <fieldset><legend>This tag is for</legend>
          <div class="check-group">${TAG_KINDS.map(
            (k) => html`<label><input type="radio" name="kind" value="${k.key}" ${d.kind === k.key ? 'checked' : ''} /> ${k.label}</label>`,
          )}</div>
        </fieldset>
        ${d.kind === 'lift'
          ? html`<label class="field"><span>Lift</span><select name="ref">${active.map(
              (l) => html`<option value="${l.unit}" ${l.unit === d.ref ? 'selected' : ''}>${l.unit} — ${byKey(cfg.liftTypes)[l.type]?.short ?? l.type}</option>`,
            )}</select></label>`
          : html`<label class="field"><span>${d.kind === 'battery' ? 'Battery number' : 'Person’s name'}</span>
              <input type="text" name="ref" value="${d.ref}" placeholder="${d.kind === 'battery' ? 'e.g. B-12' : 'e.g. Maria Lopez'}" /></label>`}
        ${d.kind !== 'person'
          ? html`<label class="row" style="gap:10px;flex-wrap:nowrap;align-items:flex-start"><input type="checkbox" name="write" ${d.write ? 'checked' : ''} style="width:22px;height:22px;flex:none;margin-top:2px" />
              <span><strong>Also write a link onto the tag</strong><br><span class="muted small">Recommended. Then the tag works offline, and tapping it with any NFC phone opens the app.</span></span></label>`
          : ''}
        ${nfcSupported ? html`<button class="btn primary" type="button" id="tapTag">📶 Tap tag now</button>` : ''}
        <div id="tagStatus" class="scan-hint"></div>
        <details ${nfcSupported ? '' : 'open'}><summary class="small"><strong>Enter a tag ID or barcode by hand</strong></summary>
          <div class="row" style="margin-top:8px">
            <input type="text" name="uid" placeholder="e.g. 04:A2:3B:1C:5D:80" style="flex:1;min-width:180px" />
            <button class="btn small" type="submit">Save</button>
          </div>
        </details>
      </form>
      <div class="stack">
        <h2 style="margin:0">Registered tags (${tags.length})</h2>
        ${tags.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>For</th><th>Tag ID</th><th></th></tr></thead>
              <tbody>${tags.map(
                (t) => html`<tr><td>${kindLabel[t.kind] ?? t.kind} <strong>${t.ref}</strong></td>
                  <td class="small" style="font-family:ui-monospace,monospace">${t.uid}</td>
                  <td><button class="btn small" type="button" data-del="${t.id}">Remove</button></td></tr>`,
              )}</tbody></table></div>`
          : html`<div class="card muted small">No tags registered yet. Tags you write a link onto work even without being registered here, but registering
              them means a tag still works if its link gets erased, and lets you use badges or tags you can't write to.</div>`}
        ${(() => {
          const tagged = new Set(tags.filter((t) => t.kind === 'lift').map((t) => t.ref));
          const missing = active.filter((l) => !tagged.has(l.unit));
          return missing.length && tags.length
            ? html`<p class="muted small">Lifts without a registered tag: ${missing.map((l) => l.unit).join(', ')}</p>`
            : '';
        })()}
      </div>
    </div>`,
  );

  const form = document.getElementById('tagForm');
  const status = document.getElementById('tagStatus');
  const sync = () => {
    d.kind = form.querySelector('input[name=kind]:checked').value;
    d.ref = form.elements.ref?.value ?? '';
    d.write = form.elements.write ? form.elements.write.checked : false;
  };
  form.querySelectorAll('input[name=kind]').forEach((r) => {
    r.onchange = () => {
      sync();
      d.ref = '';
      show(tagsSection);
    };
  });
  form.oninput = sync;
  let armed = false;

  async function register(uid, { fromNfc }) {
    sync();
    if (!d.ref) {
      beep(false);
      return toast(d.kind === 'battery' ? 'Enter the battery number first' : 'Enter the name first', { error: true });
    }
    try {
      const saved = await api('POST', '/api/manager/tags', { uid, kind: d.kind, ref: d.ref });
      let wrote = false;
      if (fromNfc && d.write && d.kind !== 'person') {
        status.textContent = 'Writing link… keep holding the tag';
        try {
          await scanner.writeUrl(linkFor(d.kind, saved.ref));
          wrote = true;
        } catch {
          toast("Registered, but couldn't write the link (tag locked or moved away). It will still work by its ID.", { ms: 7000 });
        }
      }
      beep(true);
      toast(`✅ Tag registered to ${saved.ref}${wrote ? ' and link written' : ''}`);
      // Move on to the next lift so a whole fleet can be tagged quickly.
      if (d.kind === 'lift') {
        const i = active.findIndex((l) => l.unit === saved.ref);
        d.ref = active[i + 1]?.unit ?? saved.ref;
      } else {
        d.ref = '';
      }
      show(tagsSection);
    } catch (err) {
      beep(false);
      status.textContent = '';
      toast(err.message, { error: true });
    }
  }

  scanner.setHandler(async (scan) => {
    if (scan.error) return toast(scan.error, { error: true });
    if (scan.source === 'wedge') {
      form.elements.uid.value = scan.text;
      form.querySelector('details').open = true;
      return;
    }
    if (!armed) return toast(`Read tag ${scan.serial}. Press “Tap tag now” first to register it.`);
    armed = false;
    if (!scan.serial) return toast("This tag didn't report an ID. Try another tag.", { error: true });
    status.textContent = `Read ${scan.serial}…`;
    await register(scan.serial, { fromNfc: true });
  });

  document.getElementById('tapTag')?.addEventListener('click', async () => {
    sync();
    if (!d.ref) return toast(d.kind === 'lift' ? 'Pick the lift first' : 'Fill in who/what the tag is for first', { error: true });
    const s = await scanner.startNfc();
    if (s !== 'on') {
      return toast(
        s === 'disabled' ? 'Turn on NFC in Android settings first.' : 'NFC permission is needed. Allow it when Chrome asks.',
        { error: true, ms: 7000 },
      );
    }
    armed = true;
    status.textContent = `Hold the tag for ${d.ref} to the back of the device…`;
  });

  form.onsubmit = (e) => {
    e.preventDefault();
    const uid = form.elements.uid.value.trim();
    if (!uid) return toast('Type or scan the tag ID', { error: true });
    register(uid, { fromNfc: false });
  };

  $section().querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this tag? Scanning it will no longer be recognised (unless a link is written on it).')) return;
      await api('DELETE', `/api/manager/tags/${b.dataset.del}`);
      show(tagsSection);
    };
  });
}

// ----- settings -----
async function settingsSection() {
  const s = await api('GET', '/api/manager/settings');
  mount(
    $section(),
    html`<form class="card stack" id="settingsForm" style="max-width:640px" novalidate>
      <h2 style="margin:0">Settings</h2>
      <label class="field"><span>Site name</span><input type="text" name="siteName" value="${s.siteName}" /></label>
      <label class="field"><span>Low charge alert at or below (%)</span>
        <input type="number" name="lowChargePct" min="0" max="100" value="${s.lowChargePct}" /></label>
      <label class="field"><span>Escalate DOWN lifts not acknowledged within (minutes)</span>
        <input type="number" name="escalateAfterMinutes" min="0" max="1440" value="${s.escalateAfterMinutes}" />
      </label>
      <p class="muted small" style="margin:0">Escalations go to rules with the “DOWN lift not acknowledged in time” event. 0 turns escalation off.</p>
      <button class="btn primary small" type="submit">💾 Save settings</button>
      <hr style="border:none;border-top:1px solid var(--line);width:100%">
      <div class="small">
        <strong>Server alert delivery</strong>
        <div>✉️ Email: ${delivery.email ? html`<span class="status-sent">on (${delivery.email})</span>` : html`<span class="status-skipped">not set up</span>`}</div>
        <div>📱 Text: ${delivery.sms ? html`<span class="status-sent">on (Twilio)</span>` : html`<span class="status-skipped">not set up</span>`}</div>
        <div>💬 Teams/Slack webhooks: <span class="status-sent">on</span></div>
        <div>🔗 Ticket links in alerts: ${delivery.publicUrl ? html`<span class="status-sent">${delivery.publicUrl}</span>` : html`<span class="status-skipped">PUBLIC_URL not set</span>`}</div>
      </div>
    </form>`,
  );
  const form = document.getElementById('settingsForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const saved = await api('PUT', '/api/manager/settings', {
        siteName: form.elements.siteName.value,
        lowChargePct: Number(form.elements.lowChargePct.value),
        escalateAfterMinutes: Number(form.elements.escalateAfterMinutes.value),
      });
      cfg.siteName = saved.siteName;
      document.getElementById('siteName').textContent = `· ${saved.siteName} · Manager`;
      toast('✅ Settings saved');
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}

init().catch((err) => mount($view, html`<div class="banner down">Can't reach the server: ${err.message}</div>`));
