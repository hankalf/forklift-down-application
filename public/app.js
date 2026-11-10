// Worker app: pick a lift (or scan its QR) → report a problem / battery change
// / charge level in a few taps. Reports made with no signal are saved on the
// phone and sent automatically when the connection comes back.
import { api, CHANNEL_ICON, html, ls, mount, resizeImage, timeAgo, toast, uuid } from './common.js';
import { beep, createScanner, parseTagText } from './scan.js';

const $view = document.getElementById('view');
const $back = document.getElementById('backBtn');
const $outbox = document.getElementById('outboxBanner');
const $nfc = document.getElementById('nfcBtn');
let scanner;

const state = {
  config: ls.get('fd.config', null),
  lifts: ls.get('fd.lifts', []),
  lift: null,
  draft: {},
  result: null,
  view: 'pick',
};

const PARENT = {
  menu: 'pick',
  category: 'menu',
  severity: 'category',
  details: 'severity',
  change: 'menu',
  charge: 'menu',
  note: 'menu',
  done: 'menu',
};

const byKey = (list) => Object.fromEntries((list ?? []).map((x) => [x.key, x]));
const cat = () => byKey(state.config?.categories);
const types = () => byKey(state.config?.liftTypes);
const name = () => ls.get('fd.name', '');

// ---------------- navigation ----------------
function urlFor() {
  return state.lift ? `/?lift=${encodeURIComponent(state.lift.unit)}` : '/';
}

function go(view, { replace = false } = {}) {
  state.view = view;
  const depth = (history.state?.depth ?? 0) + (replace ? 0 : 1);
  const entry = { view, unit: state.lift?.unit ?? null, depth };
  if (replace) history.replaceState(entry, '', urlFor());
  else history.pushState(entry, '', urlFor());
  render();
  window.scrollTo(0, 0);
}

// A view is only reachable if the data it needs is still there (e.g. after
// sending a report, "back" must not land on the filled-in form again).
function canShow(view) {
  if (view === 'pick') return true;
  if (!state.lift) return false;
  const d = state.draft;
  switch (view) {
    case 'severity':
      return !!d.category;
    case 'details':
      return !!d.category && !!d.severity;
    case 'note':
      return !!d.ticket;
    case 'done':
      return !!state.result;
    default:
      return true;
  }
}

window.addEventListener('popstate', (e) => {
  let view = e.state?.view ?? 'pick';
  if (view === 'pick') state.lift = null;
  if (!canShow(view)) view = state.lift ? 'menu' : 'pick';
  state.view = view;
  render();
});

$back.addEventListener('click', () => {
  if ((history.state?.depth ?? 0) > 0) history.back();
  else {
    const parent = PARENT[state.view] ?? 'pick';
    if (parent === 'pick') state.lift = null;
    go(parent, { replace: true });
  }
});

function render() {
  if (!canShow(state.view)) state.view = state.lift ? 'menu' : 'pick';
  $back.classList.toggle('hidden', state.view === 'pick');
  VIEWS[state.view]();
  renderOutbox();
}

// ---------------- data ----------------
async function loadConfig() {
  try {
    state.config = await api('GET', '/api/config');
    ls.set('fd.config', state.config);
  } catch {
    /* offline: keep cached copy */
  }
  document.getElementById('siteName').textContent = state.config?.siteName ? `· ${state.config.siteName}` : '';
}

async function refreshLifts() {
  try {
    state.lifts = await api('GET', '/api/lifts');
    ls.set('fd.lifts', state.lifts);
    if (state.view === 'pick') renderLiftList();
  } catch {
    /* offline */
  }
}

async function openLift(unit, { replace = false } = {}) {
  try {
    state.lift = await api('GET', `/api/lifts/${encodeURIComponent(unit)}`);
  } catch (err) {
    if (err.status === 404) {
      toast(`No lift "${unit}" — pick it from the list`, { error: true });
      state.lift = null;
      return go('pick', { replace: true });
    }
    // Offline: fall back to the cached fleet list so the worker can still report.
    const cached = state.lifts.find((l) => l.unit.toLowerCase() === String(unit).toLowerCase());
    if (!cached) {
      toast('No connection and this lift is not saved on the phone yet', { error: true });
      return go('pick', { replace: true });
    }
    state.lift = { ...cached, openTickets: [], recentBattery: [], offline: true };
  }
  const recent = ls.get('fd.recent', []).filter((u) => u !== state.lift.unit);
  ls.set('fd.recent', [state.lift.unit, ...recent].slice(0, 6));
  state.draft = {};
  go('menu', { replace });
}

async function reloadLift() {
  if (!state.lift) return;
  try {
    state.lift = await api('GET', `/api/lifts/${encodeURIComponent(state.lift.unit)}`);
    if (state.view === 'menu') render();
  } catch {
    /* ignore */
  }
}

// ---------------- offline outbox ----------------
const outbox = () => ls.get('fd.outbox', []);

function saveOutbox(items) {
  if (ls.set('fd.outbox', items)) return true;
  // Out of storage (big photos) — drop photos rather than lose the report.
  return ls.set(
    'fd.outbox',
    items.map((i) => ({ ...i, body: { ...i.body, photo: undefined } })),
  );
}

async function submit(url, body, label) {
  try {
    return { data: await api('POST', url, body) };
  } catch (err) {
    const needsPin = err.code === 'device_pin';
    if (err.offline || err.status >= 500 || needsPin) {
      saveOutbox([...outbox(), { oid: uuid(), url, body, label, at: new Date().toISOString() }]);
      if (needsPin) showDevicePin();
      return { queued: true };
    }
    throw err;
  }
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !outbox().length) return renderOutbox();
  flushing = true;
  const finished = new Set();
  let sent = 0;
  for (const item of outbox()) {
    try {
      await api('POST', item.url, item.body);
      finished.add(item.oid);
      sent += 1;
    } catch (err) {
      if (err.offline || err.status >= 500 || err.code === 'device_pin') break; // try later
      finished.add(item.oid); // rejected by the server; don't retry forever
      toast(`Could not send saved report (${item.label}): ${err.message}`, { error: true, ms: 8000 });
    }
  }
  saveOutbox(outbox().filter((i) => !finished.has(i.oid)));
  flushing = false;
  if (sent) {
    toast(`✅ Sent ${sent} saved report${sent > 1 ? 's' : ''}`);
    refreshLifts();
    reloadLift();
  }
  renderOutbox();
}

function renderOutbox() {
  const n = outbox().length;
  $outbox.className = n ? '' : 'hidden';
  if (!n) return mount($outbox, '');
  mount(
    $outbox,
    html`<div class="banner warn" style="border-radius:0;display:flex;gap:10px;align-items:center">
      <span style="flex:1">📶 ${n} report${n > 1 ? 's' : ''} saved on this phone — will send when there's signal.</span>
      <button class="btn small" id="flushNow" type="button">Send now</button>
    </div>`,
  );
  document.getElementById('flushNow').onclick = flushOutbox;
}

// ---------------- views ----------------
function statusChip(status) {
  const label = { down: 'Down', repair: 'Needs repair', available: 'OK' }[status] ?? status;
  return html`<span class="chip ${status}">${label}</span>`;
}

function liftHeader(lift) {
  const t = types()[lift.type];
  return html`<div class="card lift-head">
    <div class="unit">${lift.unit}</div>
    <div class="meta">
      <div><strong>${t?.label ?? lift.type}</strong></div>
      <div class="muted small">${[lift.zone, lift.model].filter(Boolean).join(' · ') || ' '}</div>
    </div>
    ${statusChip(lift.status)}
  </div>`;
}

function nameField() {
  return html`<label class="field"><span>Your name</span>
    <input type="text" id="name" autocomplete="name" enterkeyhint="done" value="${name()}" placeholder="First and last name" required />
  </label>`;
}

function readName() {
  const v = document.getElementById('name').value.trim();
  if (v.length < 2) {
    toast('Enter your name first', { error: true });
    document.getElementById('name').focus();
    return null;
  }
  ls.set('fd.name', v);
  return v;
}

function liftButton(l) {
  const sub = l.status === 'down' ? 'DOWN' : l.status === 'repair' ? 'REPAIR' : '';
  return html`<button class="lift-btn ${l.status}" type="button" data-unit="${l.unit}">
    <span class="dot ${l.status}"></span>${l.unit}${sub ? html`<small>${sub}</small>` : ''}
  </button>`;
}

function renderLiftList() {
  const box = document.getElementById('liftList');
  if (!box) return;
  // "r3", "R03", "r-03" and "3" should all find R-03: ignore case, dashes and leading zeros.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const loose = (s) => norm(s).replace(/(^|[a-z])0+(?=\d)/g, '$1');
  const raw = document.getElementById('q')?.value ?? '';
  const q = norm(raw);
  const match = (l) => !q || norm(l.unit).includes(q) || loose(l.unit).includes(loose(raw));
  const lifts = state.lifts.filter(match);
  const recentUnits = ls.get('fd.recent', []);
  const recent = q ? [] : recentUnits.map((u) => state.lifts.find((l) => l.unit === u)).filter(Boolean);

  const groups = (state.config?.liftTypes ?? []).map((t) => ({
    label: t.label,
    lifts: lifts.filter((l) => l.type === t.key),
  }));
  const known = new Set((state.config?.liftTypes ?? []).map((t) => t.key));
  const other = lifts.filter((l) => !known.has(l.type));
  if (other.length) groups.push({ label: 'Other', lifts: other });

  mount(
    box,
    html`${recent.length
      ? html`<h3>Your recent lifts</h3><div class="lift-grid">${recent.map(liftButton)}</div>`
      : ''}
    ${groups
      .filter((g) => g.lifts.length)
      .map((g) => html`<h3>${g.label}s</h3><div class="lift-grid">${g.lifts.map(liftButton)}</div>`)}
    ${!lifts.length
      ? html`<p class="muted center">${state.lifts.length ? `No lift matches “${raw}”.` : 'Loading lifts…'}</p>`
      : ''}`,
  );
  box.querySelectorAll('[data-unit]').forEach((b) => {
    b.onclick = () => openLift(b.dataset.unit);
  });
}

const VIEWS = {
  pick() {
    mount(
      $view,
      html`<h1>Which lift?</h1>
        <p class="muted small" style="margin-top:-6px">${scanner?.nfcState === 'on'
          ? '📶 Tap the lift’s NFC tag or scan its QR code to skip this step.'
          : 'Tip: scan the QR code on the lift to skip this step.'}</p>
        <input type="search" id="q" placeholder="Type the unit number…" autocomplete="off" inputmode="text" aria-label="Search lifts" />
        <div id="liftList"></div>
        <p class="center small" style="margin-top:32px"><a href="/manager">Manager dashboard</a></p>`,
    );
    const q = document.getElementById('q');
    q.oninput = renderLiftList;
    q.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const first = document.querySelector('#liftList [data-unit]');
      if (first) openLift(first.dataset.unit);
    };
    renderLiftList();
  },

  menu() {
    const l = state.lift;
    const c = cat();
    const lastCharge = l.lastCharge;
    mount(
      $view,
      html`<div class="stack">
        ${liftHeader(l)}
        ${l.offline ? html`<div class="banner info small">No signal — you can still report. It will send when you're back on WiFi.</div>` : ''}
        ${l.status === 'down'
          ? html`<div class="banner down">⛔ This lift is DOWN. Do not use it.</div>`
          : ''}
        ${l.openTickets?.length
          ? html`<h3>Already reported</h3>
            ${l.openTickets.map(
              (t) => html`<div class="card issue ${t.severity}">
                <div class="row">
                  <strong>${c[t.category]?.icon ?? ''} ${t.categoryLabel}</strong>
                  <span class="spacer"></span>
                  <span class="chip ${t.severity === 'down' ? 'down' : 'repair'}">${t.severityLabel}</span>
                </div>
                ${t.description ? html`<div style="margin-top:6px">“${t.description}”</div>` : ''}
                <div class="muted small" style="margin-top:6px">
                  ${t.reportedBy} · ${timeAgo(t.createdAt)} · <strong>${t.statusLabel}</strong>${t.assignedTo ? ` · ${t.assignedTo}` : ''}
                </div>
                <button class="btn small" style="margin-top:10px" type="button" data-note="${t.id}">➕ Same problem — add info</button>
              </div>`,
            )}`
          : ''}
        <h3>What do you need to do?</h3>
        <button class="btn big danger" type="button" id="goIssue">
          <span class="icon">🔧</span><span class="label">Report a problem<span class="sub">Down, damaged, or needs repair</span></span>
        </button>
        ${l.power !== 'lithium'
          ? html`<button class="btn big" type="button" id="goChange">
              <span class="icon">🔋</span><span class="label">Battery change<span class="sub">I swapped the battery</span></span>
            </button>`
          : ''}
        <button class="btn big" type="button" id="goCharge">
          <span class="icon">⚡</span><span class="label">Log charge level<span class="sub">${lastCharge
            ? `Last: ${lastCharge.pct}% · ${timeAgo(lastCharge.at)}`
            : 'What the battery gauge shows'}</span></span>
        </button>
        <button class="btn ghost" type="button" id="goPick">Pick a different lift</button>
      </div>`,
    );
    document.getElementById('goIssue').onclick = () => {
      state.draft = {};
      go('category');
    };
    document.getElementById('goChange')?.addEventListener('click', () => {
      state.draft = {};
      go('change');
    });
    document.getElementById('goCharge').onclick = () => {
      state.draft = {};
      go('charge');
    };
    document.getElementById('goPick').onclick = () => {
      state.lift = null;
      go('pick');
    };
    $view.querySelectorAll('[data-note]').forEach((b) => {
      b.onclick = () => {
        state.draft = { ticket: l.openTickets.find((t) => String(t.id) === b.dataset.note) };
        go('note');
      };
    });
  },

  category() {
    const l = state.lift;
    mount(
      $view,
      html`<h1>What's wrong with ${l.unit}?</h1>
        <div class="tiles">
          ${state.config.categories.map(
            (c) => html`<button class="tile ${c.safety ? 'safety' : ''}" type="button" data-cat="${c.key}">
              <span class="icon" aria-hidden="true">${c.icon}</span>${c.label}
            </button>`,
          )}
        </div>`,
    );
    $view.querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => {
        state.draft.category = b.dataset.cat;
        go('severity');
      };
    });
  },

  severity() {
    const l = state.lift;
    const c = cat()[state.draft.category];
    mount(
      $view,
      html`<div class="stack">
        <h1>Can ${l.unit} still be used safely?</h1>
        <p class="muted" style="margin-top:-6px">${c.icon} ${c.label}</p>
        ${c.safety
          ? html`<div class="banner down">⚠️ ${c.label} problems are a safety issue. <strong>If in doubt, it's DOWN.</strong></div>`
          : ''}
        <button class="btn big danger" type="button" data-sev="down">
          <span class="icon">⛔</span><span class="label">No — it's DOWN<span class="sub">Unsafe or won't run. Take it out of service.</span></span>
        </button>
        <button class="btn big warn" type="button" data-sev="repair">
          <span class="icon">🛠️</span><span class="label">Yes — still runs<span class="sub">Safe for now, but needs a tech</span></span>
        </button>
      </div>`,
    );
    $view.querySelectorAll('[data-sev]').forEach((b) => {
      b.onclick = () => {
        state.draft.severity = b.dataset.sev;
        go('details');
      };
    });
  },

  details() {
    const l = state.lift;
    const d = state.draft;
    const c = cat()[d.category];
    const down = d.severity === 'down';
    mount(
      $view,
      html`<form class="stack" id="form" novalidate>
        <div class="row">
          <span class="chip neutral">${l.unit}</span>
          <span class="chip neutral">${c.icon} ${c.label}</span>
          <span class="chip ${down ? 'down' : 'repair'}">${down ? 'Down' : 'Needs repair'}</span>
        </div>
        <h1>Anything the tech should know?</h1>
        <label class="field"><span>What's happening? <em>(optional)</em></span>
          <textarea id="desc" maxlength="1000" placeholder="e.g. Forks drift down when holding a load">${d.description ?? ''}</textarea>
        </label>
        <label class="field"><span>Error code on the display <em>(optional)</em></span>
          <input type="text" id="code" maxlength="40" autocapitalize="characters" value="${d.errorCode ?? ''}" placeholder="e.g. E-0123" />
        </label>
        <div>
          <input type="file" id="photoInput" accept="image/*" capture="environment" class="sr-only" />
          ${d.photo
            ? html`<img class="photo-preview" src="${d.photo}" alt="Photo of the problem" />
                <button class="btn small" type="button" id="removePhoto" style="margin-top:8px">Remove photo</button>`
            : html`<button class="btn" type="button" id="addPhoto">📷 Add a photo <span class="muted small">(optional)</span></button>`}
        </div>
        ${nameField()}
        <button class="btn ${down ? 'danger' : 'primary'}" type="submit" id="send" style="min-height:76px;font-size:22px">
          📣 Send report
        </button>
      </form>`,
    );
    const keep = () => {
      d.description = document.getElementById('desc').value;
      d.errorCode = document.getElementById('code').value;
    };
    document.getElementById('desc').oninput = keep;
    document.getElementById('code').oninput = keep;
    const input = document.getElementById('photoInput');
    document.getElementById('addPhoto')?.addEventListener('click', () => input.click());
    document.getElementById('removePhoto')?.addEventListener('click', () => {
      d.photo = null;
      render();
    });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        keep();
        d.photo = await resizeImage(file);
        render();
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      keep();
      const reportedBy = readName();
      if (!reportedBy) return;
      const btn = document.getElementById('send');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const r = await submit(
          '/api/tickets',
          {
            clientId: uuid(),
            unit: l.unit,
            category: d.category,
            severity: d.severity,
            description: d.description ?? '',
            errorCode: d.errorCode ?? '',
            reportedBy,
            photo: d.photo ?? undefined,
          },
          `${l.unit} ${c.label}`,
        );
        state.result = { kind: 'issue', severity: d.severity, category: d.category, ...r };
        state.draft = {};
        go('done', { replace: true });
        refreshLifts();
        reloadLift();
      } catch (err) {
        toast(err.message, { error: true });
        btn.disabled = false;
        btn.textContent = '📣 Send report';
      }
    };
  },

  change() {
    const l = state.lift;
    const d = state.draft;
    // The battery currently in the lift is probably the one coming out.
    const lastChange = l.recentBattery?.find((b) => b.kind === 'change' && b.batteryIn);
    d.batteryOut ??= lastChange?.batteryIn ?? '';
    d.chargePct ??= 100;
    d.scanTarget ??= 'out';
    const nfcOn = scanner?.nfcState === 'on';
    const chips = (field, values) =>
      html`<div class="chips" data-field="${field}">
        ${values.map((v) => html`<button type="button" data-v="${v}" class="${d[field] === v ? 'selected' : ''}">${v}%</button>`)}
      </div>`;
    mount(
      $view,
      html`<form class="stack" id="form" novalidate>
        ${liftHeader(l)}
        <h1>🔋 Battery change</h1>
        ${nfcOn ? html`<div class="scan-hint">📶 Tap the old battery's tag, then the new one, or type the numbers.</div>` : ''}
        <div class="card stack ${d.scanTarget === 'out' ? 'scan-target' : ''}" id="outCard">
          <label class="field"><span>Battery taken OUT <em>(number on the battery)</em></span>
            <input type="text" id="bOut" maxlength="40" autocapitalize="characters" value="${d.batteryOut}" placeholder="e.g. B-07" />
          </label>
          <div><strong>Charge left on it</strong> <span class="muted small">(optional)</span></div>
          ${chips('outChargePct', [0, 10, 20, 30, 40, 50])}
        </div>
        <button class="btn small" type="button" id="swapBat" style="align-self:center;margin:-4px auto">⇅ Swap OUT and IN</button>
        <div class="card stack ${d.scanTarget === 'in' ? 'scan-target' : ''}" id="inCard">
          <label class="field"><span>Battery put IN</span>
            <input type="text" id="bIn" maxlength="40" autocapitalize="characters" value="${d.batteryIn ?? ''}" placeholder="e.g. B-12" />
          </label>
          <div><strong>Its charge</strong></div>
          ${chips('chargePct', [100, 90, 80, 70, 60, 50])}
        </div>
        <label class="field"><span>Hour meter <em>(optional)</em></span>
          <input type="number" id="hours" inputmode="decimal" min="0" step="0.1" value="${d.hourMeter ?? ''}" />
        </label>
        ${nameField()}
        <button class="btn primary" type="submit" id="send" style="min-height:76px;font-size:22px">Save battery change</button>
      </form>`,
    );
    $view.querySelectorAll('.chips').forEach((group) => {
      group.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          const v = Number(b.dataset.v);
          d[group.dataset.field] = d[group.dataset.field] === v ? null : v;
          group.querySelectorAll('button').forEach((x) => x.classList.toggle('selected', Number(x.dataset.v) === d[group.dataset.field]));
        };
      });
    });
    const keep = () => {
      d.batteryOut = document.getElementById('bOut').value;
      d.batteryIn = document.getElementById('bIn').value;
      d.hourMeter = document.getElementById('hours').value;
    };
    $view.querySelectorAll('input').forEach((i) => i.addEventListener('input', keep));
    // Tapping a battery field makes it the target for the next tag scan.
    const target = (which) => {
      d.scanTarget = which;
      document.getElementById('outCard').classList.toggle('scan-target', which === 'out');
      document.getElementById('inCard').classList.toggle('scan-target', which === 'in');
    };
    document.getElementById('swapBat').onclick = () => {
      keep();
      [d.batteryOut, d.batteryIn] = [d.batteryIn, d.batteryOut];
      render();
    };
    document.getElementById('outCard').addEventListener('focusin', () => target('out'));
    document.getElementById('inCard').addEventListener('focusin', () => target('in'));
    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      keep();
      const reportedBy = readName();
      if (!reportedBy) return;
      await sendBattery({
        kind: 'change',
        batteryOut: d.batteryOut,
        batteryIn: d.batteryIn,
        outChargePct: d.outChargePct ?? null,
        chargePct: d.chargePct ?? null,
        hourMeter: d.hourMeter || null,
        reportedBy,
      });
    };
  },

  charge() {
    const l = state.lift;
    const d = state.draft;
    const low = state.config?.lowChargePct ?? 20;
    const color = (p) => (p <= low ? '#dc2626' : p <= 40 ? '#d97706' : p <= 60 ? '#65a30d' : '#15803d');
    mount(
      $view,
      html`<form class="stack" id="form" novalidate>
        ${liftHeader(l)}
        <h1>⚡ What does the battery gauge show?</h1>
        <div class="charge-grid">
          ${[100, 90, 80, 70, 60, 50, 40, 30, 20, 10].map(
            (p) => html`<button type="button" class="charge-btn ${d.chargePct === p ? 'selected' : ''}" data-p="${p}" style="background:${color(p)}">${p}%</button>`,
          )}
        </div>
        <div id="lowWarn" class="banner warn ${d.chargePct != null && d.chargePct <= low ? '' : 'hidden'}">
          🪫 That's low — charge or swap the battery soon. Saving this alerts the battery room.
        </div>
        <label class="field"><span>Hour meter <em>(optional)</em></span>
          <input type="number" id="hours" inputmode="decimal" min="0" step="0.1" value="${d.hourMeter ?? ''}" />
        </label>
        ${nameField()}
        <button class="btn primary" type="submit" id="send" style="min-height:76px;font-size:22px" ${d.chargePct == null ? 'disabled' : ''}>
          Save charge level
        </button>
      </form>`,
    );
    $view.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => {
        d.chargePct = Number(b.dataset.p);
        $view.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('selected', x === b));
        document.getElementById('lowWarn').classList.toggle('hidden', d.chargePct > low);
        document.getElementById('send').disabled = false;
      };
    });
    document.getElementById('hours').oninput = (e) => (d.hourMeter = e.target.value);
    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      if (d.chargePct == null) return toast('Tap the charge level first', { error: true });
      const reportedBy = readName();
      if (!reportedBy) return;
      await sendBattery({ kind: 'charge', chargePct: d.chargePct, hourMeter: d.hourMeter || null, reportedBy });
    };
  },

  note() {
    const t = state.draft.ticket;
    mount(
      $view,
      html`<form class="stack" id="form" novalidate>
        <h1>Add info to ${state.lift.unit}: ${t.categoryLabel}</h1>
        <p class="muted" style="margin-top:-6px">Ticket #${t.id} · reported by ${t.reportedBy} ${timeAgo(t.createdAt)}. The team already knows — this adds your notes without re-alerting everyone.</p>
        <label class="field"><span>What did you see?</span>
          <textarea id="note" maxlength="1000" placeholder="e.g. Still happening on 2nd shift, now leaking too"></textarea>
        </label>
        ${nameField()}
        <button class="btn primary" type="submit" id="send">Add to ticket</button>
      </form>`,
    );
    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const note = document.getElementById('note').value.trim();
      if (!note) return toast('Write what you saw first', { error: true });
      const actor = readName();
      if (!actor) return;
      try {
        const r = await submit(`/api/tickets/${t.id}/notes`, { note, actor }, `note on #${t.id}`);
        toast(r.queued ? 'Saved — will send when there is signal' : `✅ Added to ticket #${t.id}`);
        state.draft = {};
        go('menu', { replace: true });
        reloadLift();
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
  },

  done() {
    const r = state.result;
    const l = state.lift;
    const issue = r.kind === 'issue';
    const down = issue && r.severity === 'down';
    const notified = r.data?.notified ?? [];
    let title;
    if (r.queued) title = 'Saved on this phone';
    else if (issue) title = `Report sent — ticket #${r.data.ticket.id}`;
    else if (r.batteryKind === 'change') title = 'Battery change saved';
    else title = `Charge level saved: ${r.chargePct}%`;
    mount(
      $view,
      html`<div class="stack center">
        <div class="success-icon">${r.queued ? '📶' : '✅'}</div>
        <h1>${title}</h1>
        ${r.queued
          ? html`<p>No signal right now. It will <strong>send automatically</strong> as soon as the phone is back on WiFi or data.</p>`
          : ''}
      </div>
      <div class="stack" style="margin-top:16px">
        ${down
          ? html`<div class="banner down">
              🔴 <strong>Tag out ${l.unit} now:</strong> hang a DO NOT OPERATE tag, take the key, and park it out of the way.
            </div>`
          : ''}
        ${r.lowCharge
          ? html`<div class="banner warn">🪫 Low charge — charge or swap the battery soon.</div>`
          : ''}
        ${!r.queued && (issue || notified.length)
          ? html`<div class="card">
              <strong>${notified.length ? 'Alerted:' : 'Logged for the manager dashboard.'}</strong>
              ${notified.length
                ? html`<ul class="timeline">
                    ${notified.map(
                      (n) => html`<li class="row" style="flex-wrap:nowrap">
                        <span style="flex:1"><strong>${n.name}</strong>${n.role ? html`<br><span class="muted small">${n.role}</span>` : ''}</span>
                        <span>${n.channels.map((c) => CHANNEL_ICON[c] ?? c).join(' ')}</span></li>`,
                    )}
                  </ul>`
                : ''}
            </div>`
          : ''}
        <button class="btn primary" type="button" id="finish">Done</button>
        <button class="btn" type="button" id="again">Something else on ${l.unit}</button>
      </div>`,
    );
    document.getElementById('finish').onclick = () => {
      state.result = null;
      state.lift = null;
      go('pick', { replace: true });
    };
    document.getElementById('again').onclick = () => {
      state.result = null;
      go('menu', { replace: true });
    };
  },
};

async function sendBattery(body) {
  const btn = document.getElementById('send');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const l = state.lift;
    const r = await submit(
      '/api/battery',
      { clientId: uuid(), unit: l.unit, ...body },
      `${l.unit} ${body.kind === 'change' ? 'battery change' : 'charge level'}`,
    );
    const low = state.config?.lowChargePct ?? 20;
    state.result = {
      kind: 'battery',
      batteryKind: body.kind,
      chargePct: body.chargePct,
      lowCharge: r.data ? r.data.lowCharge : body.chargePct != null && body.chargePct <= low,
      ...r,
    };
    state.draft = {};
    go('done', { replace: true });
    reloadLift();
  } catch (err) {
    toast(err.message, { error: true });
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------------- NFC tags & scanner trigger ----------------
function renderNfc(nfcState) {
  const look = {
    on: { text: '📶 NFC', cls: 'on', title: 'NFC tag scanning is on' },
    'needs-tap': { text: '📶 Turn on NFC', cls: 'attention', title: 'Tap to allow NFC tag scanning' },
    disabled: { text: '📶 NFC off', cls: 'attention', title: 'Turn on NFC in Android settings' },
    denied: { text: '📶 NFC blocked', cls: 'attention', title: 'NFC permission was blocked' },
    error: { text: '📶 Retry NFC', cls: 'attention', title: 'NFC could not start' },
  }[nfcState];
  $nfc.classList.toggle('hidden', !look);
  if (!look) return;
  $nfc.textContent = look.text;
  $nfc.title = look.title;
  $nfc.className = `nfc ${look.cls}`;
  if (state.view === 'pick' || state.view === 'change') render();
}

$nfc.addEventListener('click', async () => {
  const s = scanner.nfcState;
  if (s === 'on') return toast('NFC is on — hold a tag to the back of the device');
  if (s === 'denied') {
    return toast('NFC is blocked for this site. In Chrome: ⋮ → Settings → Site settings → NFC devices → allow it.', { error: true, ms: 9000 });
  }
  const result = await scanner.startNfc();
  if (result === 'on') toast('📶 NFC on — tap a lift, battery or badge tag');
  else if (result === 'disabled') toast('Turn on NFC in Android settings (swipe down → NFC), then tap again.', { error: true, ms: 8000 });
});

async function resolveScan(scan) {
  try {
    return await api('POST', '/api/scan', { serial: scan.serial, text: scan.text }, { timeoutMs: 8000 });
  } catch (err) {
    if (!err.offline && !(err.status >= 500)) throw err;
    // No signal: tags with data written on them and QR labels still work.
    const hit = parseTagText(scan.text);
    if (hit) return hit;
    const lift = state.lifts.find((l) => l.unit.toLowerCase() === String(scan.text).trim().toLowerCase());
    if (lift) return { kind: 'lift', ref: lift.unit };
    return { kind: 'unknown', offline: true, serial: scan.serial, text: scan.text };
  }
}

function flashField(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// Put a scanned battery in the right box. A battery we know is in this lift
// is coming OUT; one we know was taken out (charging) is going IN; otherwise
// it goes wherever the dashed outline is.
function applyBatteryScan(ref, location) {
  const d = state.draft;
  let field;
  if (location?.state === 'in_lift' && location.unit === state.lift.unit) field = 'out';
  else if (location) field = 'in';
  else field = d.scanTarget === 'in' ? 'in' : 'out';
  const other = field === 'out' ? d.batteryIn : d.batteryOut;
  if (other && other.toUpperCase() === ref.toUpperCase()) {
    beep(false);
    return toast(`${ref} is already entered as the battery going ${field === 'out' ? 'IN' : 'OUT'}`, { error: true });
  }
  if (field === 'out') {
    d.batteryOut = ref;
    d.scanTarget = 'in';
  } else {
    d.batteryIn = ref;
    if (location?.chargePct != null && location.state === 'out') d.chargePct = location.chargePct;
    d.scanTarget = d.batteryOut ? 'in' : 'out';
  }
  render();
  flashField(field === 'out' ? 'bOut' : 'bIn');
  toast(`🔋 ${ref} → ${field.toUpperCase()}`);
}

async function handleScan(scan) {
  if (scan.error) {
    beep(false);
    return toast(scan.error, { error: true });
  }
  let r;
  try {
    r = await resolveScan(scan);
  } catch (err) {
    beep(false);
    return toast(err.message, { error: true });
  }
  if (r.kind === 'unknown' && scan.source === 'wedge' && scan.text) {
    // A barcode we don't recognise: on the battery screen it's a battery
    // number; elsewhere it goes into the field the worker was in.
    if (state.view === 'change') {
      beep(true);
      return applyBatteryScan(scan.text.trim(), null);
    }
    if (scan.field && document.body.contains(scan.field)) {
      scan.field.value = scan.text;
      scan.field.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }
  beep(r.kind !== 'unknown');

  if (r.kind === 'lift') {
    if (state.lift?.unit === r.ref && state.view !== 'pick') return toast(`✓ That's ${r.ref}`);
    toast(`📶 ${r.ref}`);
    return openLift(r.ref);
  }

  if (r.kind === 'battery') {
    if (state.view === 'change') return applyBatteryScan(r.ref, r.location);
    const unit = state.lift?.unit ?? (r.location?.state === 'in_lift' ? r.location.unit : null);
    if (!unit) return toast(`🔋 ${r.ref} — scan the lift's tag first`, { ms: 5000 });
    if (state.lift?.unit !== unit) await openLift(unit);
    if (state.lift?.unit !== unit) return;
    if (state.lift.power === 'lithium') return toast(`${unit} has a lithium battery — use “Log charge level”`, { error: true });
    state.draft = {};
    go('change');
    return applyBatteryScan(r.ref, r.location);
  }

  if (r.kind === 'person') {
    ls.set('fd.name', r.ref);
    const input = document.getElementById('name');
    if (input) {
      input.value = r.ref;
      flashField('name');
    }
    return toast(`👋 Hi ${r.ref}`);
  }

  toast(
    r.message ??
      (r.offline
        ? 'No signal — this tag needs a connection to look up'
        : scan.serial
          ? `Unknown tag (${scan.serial}). Ask a manager to register it.`
          : `Unknown code “${scan.text}”`),
    { error: true, ms: 6000 },
  );
}

// ---------------- one-time site PIN (WORKER_PIN) ----------------
function showDevicePin(onDone = () => location.reload()) {
  $back.classList.add('hidden');
  mount(
    $view,
    html`<form class="stack" id="pinForm" novalidate style="max-width:420px;margin:8vh auto 0">
      <div class="center success-icon">🔒</div>
      <h1 class="center">Enter the site PIN</h1>
      <p class="muted center" style="margin-top:-6px">Only needed once on this device. Ask your supervisor if you don't know it.</p>
      <input type="password" id="sitePin" inputmode="numeric" autocomplete="off" aria-label="Site PIN" style="text-align:center;font-size:28px;letter-spacing:6px" />
      <button class="btn primary" type="submit">Unlock this device</button>
    </form>`,
  );
  const input = document.getElementById('sitePin');
  input.focus();
  document.getElementById('pinForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/device/login', { pin: input.value });
      toast('✅ Device unlocked');
      onDone();
    } catch (err) {
      toast(err.message, { error: true });
      input.select();
    }
  };
}

// ---------------- start ----------------
async function init() {
  await loadConfig();
  if (!state.config) {
    mount($view, html`<div class="banner down">Can't reach the server. Connect to WiFi and try again.</div>`);
    window.addEventListener('online', () => location.reload(), { once: true });
    return;
  }
  if (state.config.devicePinRequired) {
    const session = await api('GET', '/api/device/session').catch(() => null);
    if (session && !session.enrolled) return showDevicePin();
  }
  scanner = createScanner({ onScan: handleScan, onNfcState: renderNfc });
  scanner.autoStartNfc();
  const params = new URLSearchParams(location.search);
  const unit = params.get('lift');
  const scanParam = params.get('scan'); // from battery tag links: /b/B-12
  history.replaceState({ view: 'pick', depth: 0 }, '', '/');
  if (unit) {
    await openLift(unit, { replace: true });
  } else {
    render();
    if (scanParam) handleScan({ source: 'link', serial: '', text: scanParam });
  }
  refreshLifts();
  flushOutbox();
  window.addEventListener('online', flushOutbox);
  setInterval(flushOutbox, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      flushOutbox();
      refreshLifts();
    }
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

init();
