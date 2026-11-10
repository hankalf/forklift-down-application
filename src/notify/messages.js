import { categoryLabel, liftTypeLabel } from '../catalog.js';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function formatTime(iso) {
  return timeFmt.format(new Date(iso));
}

export function formatDuration(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function liftLine(lift) {
  const zone = lift.zone ? `, ${lift.zone}` : '';
  return `${lift.unit} (${liftTypeLabel(lift.type)}${zone})`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Build the subject/body for every channel from one notification event.
// `event.link` (optional) is a URL to the ticket page.
export function buildMessage(event) {
  const { type, lift, ticket, battery, link } = event;
  const lines = [];
  let subject;
  let sms;

  if (type === 'issue_reported' || type === 'issue_escalated') {
    const down = ticket.severity === 'down';
    const cat = categoryLabel(ticket.category);
    const tag = type === 'issue_escalated' ? 'ESCALATION' : down ? 'DOWN' : 'Needs repair';
    subject = `[${tag}] ${lift.unit} ${liftTypeLabel(lift.type)} — ${cat} (#${ticket.id})`;
    const head =
      type === 'issue_escalated'
        ? `⏰ STILL DOWN — NOT ACKNOWLEDGED after ${formatDuration(Date.now() - Date.parse(ticket.createdAt))}`
        : down
          ? '🔴 LIFT DOWN'
          : '🟠 Needs repair (still running)';
    lines.push(`${head}: ${liftLine(lift)}`);
    lines.push(`Problem: ${cat}`);
    if (ticket.errorCode) lines.push(`Error code: ${ticket.errorCode}`);
    if (ticket.description) lines.push(`Details: "${ticket.description}"`);
    lines.push(`Reported by ${ticket.reportedBy} at ${formatTime(ticket.createdAt)}`);
    lines.push(`Ticket #${ticket.id}`);
    sms = [
      `${head}: ${liftLine(lift)} – ${cat}.`,
      ticket.errorCode ? `Code ${ticket.errorCode}.` : '',
      ticket.description ? `"${truncate(ticket.description, 120)}"` : '',
      `– ${ticket.reportedBy} ${formatTime(ticket.createdAt)}. #${ticket.id}`,
    ]
      .filter(Boolean)
      .join(' ');
  } else if (type === 'issue_resolved') {
    const cat = categoryLabel(ticket.category);
    const took = formatDuration(Date.parse(ticket.resolvedAt ?? new Date().toISOString()) - Date.parse(ticket.createdAt));
    const stillOpen = event.otherOpenCount ?? 0;
    subject = `[Resolved] ${lift.unit} ${liftTypeLabel(lift.type)} — ${cat} (#${ticket.id})`;
    const head = stillOpen ? '✅ Issue fixed' : '✅ BACK IN SERVICE';
    lines.push(`${head}: ${liftLine(lift)}`);
    lines.push(`Problem: ${cat} (${ticket.severity === 'down' ? 'was DOWN' : 'needed repair'} for ${took})`);
    if (ticket.resolution) lines.push(`Fix: "${ticket.resolution}"`);
    if (event.actor) lines.push(`Closed by ${event.actor}`);
    if (stillOpen) lines.push(`⚠️ ${lift.unit} still has ${stillOpen} other open issue(s).`);
    lines.push(`Ticket #${ticket.id}`);
    sms = [
      `${head}: ${lift.unit} – ${cat} fixed after ${took}.`,
      ticket.resolution ? `"${truncate(ticket.resolution, 120)}"` : '',
      stillOpen ? `Still ${stillOpen} other open issue(s).` : '',
      `#${ticket.id}`,
    ]
      .filter(Boolean)
      .join(' ');
  } else if (type === 'battery_change') {
    subject = `[Battery change] ${lift.unit} ${liftTypeLabel(lift.type)}`;
    const inPart = `${battery.batteryIn || 'battery'} in${battery.chargePct != null ? ` @ ${battery.chargePct}%` : ''}`;
    const outPart = battery.batteryOut
      ? `, ${battery.batteryOut} out${battery.outChargePct != null ? ` @ ${battery.outChargePct}%` : ''}`
      : '';
    lines.push(`🔋 Battery changed: ${liftLine(lift)}`);
    lines.push(`${inPart}${outPart}`);
    if (battery.hourMeter != null) lines.push(`Hour meter: ${battery.hourMeter}`);
    if (battery.notes) lines.push(`Notes: "${battery.notes}"`);
    lines.push(`By ${battery.reportedBy} at ${formatTime(battery.createdAt)}`);
    sms = `🔋 ${lift.unit} battery change: ${inPart}${outPart}. – ${battery.reportedBy} ${formatTime(battery.createdAt)}`;
  } else if (type === 'low_battery') {
    subject = `[Low charge] ${lift.unit} at ${battery.chargePct}%`;
    const what = battery.kind === 'change' ? 'Battery just swapped in at only' : 'Charge level';
    lines.push(`🪫 LOW CHARGE: ${liftLine(lift)}`);
    lines.push(`${what} ${battery.chargePct}%${battery.batteryIn ? ` (battery ${battery.batteryIn})` : ''}`);
    if (battery.notes) lines.push(`Notes: "${battery.notes}"`);
    lines.push(`Reported by ${battery.reportedBy} at ${formatTime(battery.createdAt)}`);
    sms = `🪫 LOW CHARGE: ${lift.unit} at ${battery.chargePct}%${battery.kind === 'change' ? ' right after a swap' : ''}. – ${battery.reportedBy} ${formatTime(battery.createdAt)}`;
  } else if (type === 'test') {
    subject = 'Test alert from Forklift Down';
    lines.push('✅ This is a test alert. If you got this, alerts to you are working.');
    sms = '✅ Forklift Down test alert. Alerts to this number are working.';
  } else {
    throw new Error(`Unknown event type ${type}`);
  }

  if (link) {
    lines.push('', `Open ticket: ${link}`);
    sms += ` ${link}`;
  }
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines
    .map((l) => escapeHtml(l))
    .join('<br>')}${
    link
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1d4ed8;color:#fff;border-radius:6px;text-decoration:none">Open ticket</a></p>`
      : ''
  }</div>`;
  return { subject, text, sms, html };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
