import nodemailer from 'nodemailer';

// Each sender is `async ({ to, subject, text, sms, html, link }) => void` and
// throws on failure. A missing sender means the channel is not configured;
// the notifier then records the alert as "logged" (dry run) instead.

export function createSmtpSender(smtp, from) {
  if (!smtp?.host) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return async ({ to, subject, text, html }) => {
    await transport.sendMail({ from, to, subject, text, html });
  };
}

// Resend (https://resend.com) email API over HTTPS. Use this on Railway's
// Hobby plan, where outbound SMTP ports are blocked.
export function createResendSender(apiKey, from, fetchImpl = fetch) {
  if (!apiKey) return null;
  return async ({ to, subject, text, html }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

// Twilio Programmable Messaging via its REST API (no SDK needed).
export function createSmsSender(twilio, fetchImpl = fetch) {
  if (!twilio?.accountSid || !twilio?.authToken || !twilio?.from) return null;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilio.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64');
  return async ({ to, sms }) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: twilio.from, Body: sms }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Twilio responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

// Builds the right JSON body for the kind of webhook the URL points at.
export function webhookPayload(url, { subject, text, link }) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // fall through to the generic payload
  }
  if (host === 'hooks.slack.com') {
    return { text: `*${subject}*\n${text}` };
  }
  // Microsoft Teams "Workflows" (Power Automate) webhooks take an Adaptive Card.
  if (host.endsWith('.logic.azure.com') || host.endsWith('.powerplatform.com') || host.endsWith('.powerautomate.com')) {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: subject, weight: 'Bolder', size: 'Medium', wrap: true },
              { type: 'TextBlock', text: text.replace(/\n/g, '\n\n'), wrap: true },
            ],
            actions: link ? [{ type: 'Action.OpenUrl', title: 'Open ticket', url: link }] : [],
          },
        },
      ],
    };
  }
  // Legacy Teams incoming webhooks, Google Chat, Discord-style and generic receivers.
  return { text: `**${subject}**\n\n${text}`, content: `**${subject}**\n${text}`, subject, link: link ?? null };
}

export function createWebhookSender(fetchImpl = fetch) {
  return async ({ to, subject, text, link }) => {
    const res = await fetchImpl(to, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload(to, { subject, text, link })),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Webhook responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  };
}

export function createSenders(config) {
  return {
    email: createResendSender(config.resend.apiKey, config.emailFrom) ?? createSmtpSender(config.smtp, config.emailFrom),
    sms: createSmsSender(config.twilio),
    webhook: createWebhookSender(),
  };
}
