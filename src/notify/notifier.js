import { destinationFor, resolveRecipients } from '../rules.js';
import { buildMessage } from './messages.js';

const CHANNEL_ORDER = ['sms', 'email', 'webhook'];

// Turns domain events into alerts: matches rules, formats messages, sends on
// each channel and records every attempt in the notifications table.
export class Notifier {
  constructor({ store, senders = {}, logger = console }) {
    this.store = store;
    this.senders = senders;
    this.logger = logger;
    this.pending = new Set();
  }

  // Who would be alerted for this event (no sending). Used by the rule preview.
  plan(event) {
    return resolveRecipients(this.store.listRules(), this.store.listContacts(), {
      ...event,
      at: event.at ?? new Date(),
    });
  }

  // Sends in the background. Returns right away with who is actually being
  // alerted (only channels the person has an address for and the server can
  // send on), so the worker's confirmation screen never overstates it.
  notify(event) {
    const recipients = this.plan(event);
    const jobs = recipients.length ? this.#dispatch(event, recipients) : [];
    const done = Promise.allSettled(jobs);
    this.pending.add(done);
    done.finally(() => this.pending.delete(done));
    return {
      recipients: recipients
        .map((r) => ({
          name: r.contact.name,
          role: r.contact.role,
          channels: CHANNEL_ORDER.filter(
            (ch) => r.channels.includes(ch) && destinationFor(r.contact, ch) && this.senders[ch],
          ),
        }))
        .filter((r) => r.channels.length),
      done,
    };
  }

  // Send a one-off test message to a single contact on every channel they have.
  sendTest(contact) {
    const channels = ['sms', 'email', 'webhook'].filter((ch) => destinationFor(contact, ch));
    const jobs = this.#dispatch({ type: 'test' }, [{ contact, channels }]);
    return Promise.allSettled(jobs).then(() => channels);
  }

  async flush() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  #dispatch(event, recipients) {
    const message = buildMessage(event);
    const refType = event.ticket ? 'ticket' : event.battery ? 'battery' : 'test';
    const refId = event.ticket?.id ?? event.battery?.id ?? null;
    const jobs = [];
    for (const { contact, channels } of recipients) {
      for (const channel of channels) {
        const destination = destinationFor(contact, channel);
        const record = {
          eventType: event.type,
          refType,
          refId,
          contactId: contact.id,
          contactName: contact.name,
          channel,
          destination,
          subject: message.subject,
          body: channel === 'sms' ? message.sms : message.text,
        };
        if (!destination) {
          this.store.insertNotification({ ...record, status: 'skipped', error: `No ${channel} address on file` });
          continue;
        }
        const send = this.senders[channel];
        if (!send) {
          this.store.insertNotification({
            ...record,
            status: 'logged',
            error: `${channel.toUpperCase()} not configured on the server (dry run)`,
          });
          this.logger.info?.(`[alert:dry-run] ${channel} → ${contact.name} <${destination}>: ${message.subject}`);
          continue;
        }
        const id = this.store.insertNotification({ ...record, status: 'pending' });
        jobs.push(
          Promise.resolve()
            .then(() => send({ to: destination, ...message, link: event.link }))
            .then(
              () => this.store.setNotificationStatus(id, 'sent'),
              (err) => {
                this.logger.error?.(`[alert] ${channel} to ${contact.name} failed: ${err.message}`);
                this.store.setNotificationStatus(id, 'failed', err.message);
              },
            ),
        );
      }
    }
    return jobs;
  }
}
