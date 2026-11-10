// Ticket page for techs and managers. Opened from the link in an alert
// (/t/42?k=token) or from the manager dashboard (/t/42 with a manager login).
import { api, CHANNEL_ICON, duration, fmtDateTime, html, ls, mount, timeAgo, toast } from './common.js';

const $view = document.getElementById('view');
const id = Number(location.pathname.split('/').pop());
const token = new URLSearchParams(location.search).get('k') ?? '';
const q = token ? `?k=${encodeURIComponent(token)}` : '';

const NEXT = [
  { status: 'acknowledged', label: "👍 Acknowledge — I'm on it", cls: 'primary' },
  { status: 'in_progress', label: '🔧 Working on it now', cls: '' },
  { status: 'waiting_parts', label: '📦 Waiting on parts', cls: '' },
  { status: 'resolved', label: '✅ Fixed — back in service', cls: 'ok' },
];

let data;

async function load() {
  try {
    data = await api('GET', `/api/tickets/${id}${q}`);
    render();
  } catch (err) {
    mount(
      $view,
      html`<div class="banner down">${err.status === 401
        ? html`This link isn't valid. Open the ticket from the alert again, or <a href="/manager">log in to the dashboard</a>.`
        : err.message}</div>`,
    );
  }
}

function render() {
  const { ticket: t, lift, notifications } = data;
  const closed = t.status === 'resolved';
  document.getElementById('title').textContent = `#${t.id} ${t.unit}`;
  document.title = `#${t.id} ${t.unit} ${t.categoryLabel} · Forklift Down`;
  const sevChip = html`<span class="chip ${t.severity === 'down' ? 'down' : 'repair'}">${t.severityLabel}</span>`;
  const statusChip = html`<span class="chip ${closed ? 'ok' : 'neutral'}">${t.statusLabel}</span>`;

  mount(
    $view,
    html`<div class="stack">
      <div class="card lift-head">
        <div class="unit">${t.unit}</div>
        <div class="meta">
          <div><strong>${t.liftTypeLabel}</strong></div>
          <div class="muted small">${[lift?.zone, lift?.model, lift?.serial && `S/N ${lift.serial}`].filter(Boolean).join(' · ') || ' '}</div>
        </div>
      </div>

      <div class="card stack">
        <div class="row"><h2 style="margin:0">${t.categoryLabel}</h2><span class="spacer"></span>${sevChip} ${statusChip}</div>
        ${t.errorCode ? html`<div><strong>Error code:</strong> ${t.errorCode}</div>` : ''}
        ${t.description ? html`<div style="font-size:20px">“${t.description}”</div>` : ''}
        <div class="muted small">
          Reported by <strong>${t.reportedBy}</strong> · ${fmtDateTime(t.createdAt)} (${timeAgo(t.createdAt)})
          ${closed
            ? html`<br>Resolved ${fmtDateTime(t.resolvedAt)} · ${t.severity === 'down' ? 'down' : 'open'} for ${duration(t.createdAt, t.resolvedAt)}`
            : t.severity === 'down'
              ? html`<br><strong style="color:var(--down)">Down for ${duration(t.createdAt)}</strong>`
              : ''}
          ${t.assignedTo ? html`<br>Assigned to <strong>${t.assignedTo}</strong>` : ''}
        </div>
        ${t.photos.length
          ? html`<div class="photos">${t.photos.map((p) => html`<a href="${p}" target="_blank" rel="noopener"><img src="${p}" alt="Photo of the problem" loading="lazy" /></a>`)}</div>`
          : ''}
        ${t.resolution ? html`<div class="banner ok"><strong>Fix:</strong> ${t.resolution}</div>` : ''}
      </div>

      <form class="card stack" id="update" novalidate>
        <h2 style="margin:0">${closed ? 'Re-open this ticket' : 'Update'}</h2>
        <label class="field"><span>Your name</span>
          <input type="text" id="actor" autocomplete="name" value="${ls.get('fd.techName', '') || ls.get('fd.name', '')}" />
        </label>
        <label class="field"><span>Note <em>(optional — what you found, parts ordered, ETA…)</em></span>
          <textarea id="note" maxlength="1000"></textarea>
        </label>
        <label class="field hidden" id="resWrap"><span>What was fixed? <em>(required to close)</em></span>
          <textarea id="resolution" maxlength="1000" placeholder="e.g. Replaced brake solenoid, tested OK">${t.resolution}</textarea>
        </label>
        ${closed
          ? html`<button class="btn warn" type="button" data-status="open">↩️ Re-open — still broken</button>`
          : NEXT.filter((n) => n.status !== t.status).map(
              (n) => html`<button class="btn ${n.cls}" type="button" data-status="${n.status}">${n.label}</button>`,
            )}
      </form>

      <div class="card">
        <h2>History</h2>
        <ul class="timeline">
          ${[...t.events].reverse().map(
            (e) => html`<li>
              <div class="row" style="gap:2px 8px"><strong>${e.kind === 'reported'
                ? 'Reported'
                : e.kind === 'escalated'
                  ? '⏰ Escalated'
                  : e.kind === 'note'
                    ? '💬 Note'
                    : `→ ${e.statusLabel}`}</strong>
                ${e.actor ? html`<span>${e.actor}</span>` : ''}
                <span class="spacer"></span><span class="muted small">${fmtDateTime(e.createdAt)}</span></div>
              ${e.note ? html`<div>${e.note}</div>` : ''}
            </li>`,
          )}
        </ul>
      </div>

      ${notifications.length
        ? html`<details class="card">
            <summary><strong>Alerts sent (${notifications.length})</strong></summary>
            <ul class="timeline">
              ${notifications.map(
                (n) => html`<li class="small"><div class="row" style="gap:2px 8px">${CHANNEL_ICON[n.channel] ?? n.channel} <strong>${n.contactName}</strong>
                  <span class="status-${n.status}">${n.status}</span><span class="spacer"></span><span class="muted">${fmtDateTime(n.createdAt)}</span></div>
                  ${n.error ? html`<div class="muted">${n.error}</div>` : ''}</li>`,
              )}
            </ul>
          </details>`
        : ''}
    </div>`,
  );

  const form = document.getElementById('update');
  const resWrap = document.getElementById('resWrap');
  form.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = async () => {
      const status = b.dataset.status;
      if (status === 'resolved' && resWrap.classList.contains('hidden')) {
        resWrap.classList.remove('hidden');
        document.getElementById('resolution').focus();
        b.textContent = '✅ Confirm fixed — back in service';
        return;
      }
      const actor = document.getElementById('actor').value.trim();
      if (actor.length < 2) {
        toast('Enter your name', { error: true });
        return document.getElementById('actor').focus();
      }
      ls.set('fd.techName', actor);
      const body = { status, actor, note: document.getElementById('note').value.trim() };
      if (status === 'acknowledged' && !t.assignedTo) body.assignedTo = actor;
      if (status === 'resolved') body.resolution = document.getElementById('resolution').value.trim();
      b.disabled = true;
      try {
        const r = await api('POST', `/api/tickets/${id}/status${q}`, body);
        const who = r.notified?.length ? ` — alerted ${r.notified.map((n) => n.name).join(', ')}` : '';
        toast(`✅ Updated: ${r.ticket.statusLabel}${who}`, { ms: 5000 });
        await load();
        window.scrollTo(0, 0);
      } catch (err) {
        toast(err.message, { error: true });
        b.disabled = false;
      }
    };
  });
}

load();
// Keep the page fresh, but never wipe out something the tech is typing.
setInterval(() => {
  const typing =
    document.activeElement?.matches('input, textarea') ||
    document.getElementById('note')?.value ||
    !document.getElementById('resWrap')?.classList.contains('hidden');
  if (document.visibilityState === 'visible' && !typing) load();
}, 30_000);
