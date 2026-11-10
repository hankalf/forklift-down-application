// Scanner input for Zebra Android devices (TC2x/TC5x/TC7x, MC93 "gun"…) and
// any NFC-capable Android phone.
//
// Two sources, both delivered to one callback as { source, serial, text }:
//
//  1. NFC tags via Web NFC (Chrome on Android, HTTPS only). DataWedge cannot
//     read NFC, so the page reads tags itself. `serial` is the tag's serial
//     number, `text` is any URL/text record written on it.
//
//  2. Barcodes from the scan trigger via DataWedge "Keystroke output" (or any
//     keyboard-wedge reader). Scans arrive as a fast burst of keys ending in
//     Enter — told apart from a person typing by speed. Configure DataWedge to
//     send an ENTER suffix (Basic data formatting → Send ENTER key).

const WEDGE_MAX_AVG_MS = 50; // people type far slower than this between keys
const WEDGE_MIN_LENGTH = 3;
const BURST_GAP_MS = 120;

export const nfcSupported = typeof window !== 'undefined' && 'NDEFReader' in window;

function decodeRecords(message) {
  for (const record of message?.records ?? []) {
    try {
      if (record.recordType === 'url' || record.recordType === 'absolute-url') {
        return new TextDecoder().decode(record.data);
      }
      if (record.recordType === 'text') {
        return new TextDecoder(record.encoding || 'utf-8').decode(record.data);
      }
    } catch {
      /* unreadable record: skip */
    }
  }
  return '';
}

const isTextField = (el) =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && /^(text|search|email|tel|url|number|password)$/.test(el.type));

export function createScanner({ onScan, onNfcState = () => {} }) {
  let handler = onScan;
  let reader = null;
  let abort = null;
  let nfcState = nfcSupported ? 'off' : 'unsupported';
  const setState = (s, detail) => {
    nfcState = s;
    onNfcState(s, detail);
  };

  // ---------- NFC ----------
  async function startNfc() {
    if (!nfcSupported || nfcState === 'on') return nfcState;
    try {
      reader = new NDEFReader();
      abort = new AbortController();
      await reader.scan({ signal: abort.signal });
      reader.onreading = (event) => {
        handler?.({ source: 'nfc', serial: event.serialNumber ?? '', text: decodeRecords(event.message) });
      };
      reader.onreadingerror = () => {
        handler?.({ source: 'nfc', error: "Couldn't read that tag. Hold it flat against the back of the device and try again." });
      };
      setState('on');
    } catch (err) {
      reader = null;
      // NotAllowedError: needs a tap (user gesture) or permission was denied.
      // NotReadableError: NFC is switched off in Android settings.
      setState(err.name === 'NotReadableError' ? 'disabled' : err.name === 'NotAllowedError' ? 'needs-tap' : 'error', err.message);
    }
    return nfcState;
  }

  // Start automatically if permission was already granted on this device;
  // otherwise the page shows a one-time "Turn on NFC" button (Chrome requires a tap).
  async function autoStartNfc() {
    if (!nfcSupported) return setState('unsupported');
    try {
      const status = await navigator.permissions.query({ name: 'nfc' });
      if (status.state === 'granted') return startNfc();
      setState(status.state === 'denied' ? 'denied' : 'needs-tap');
    } catch {
      setState('needs-tap');
    }
  }

  // Write a URL onto the next tag held to the device (used when registering tags).
  async function writeUrl(url, { timeoutMs = 15000 } = {}) {
    if (!nfcSupported) throw new Error('This device/browser cannot write NFC tags');
    const writer = new NDEFReader();
    await writer.write({ records: [{ recordType: 'url', data: url }] }, { signal: AbortSignal.timeout(timeoutMs) });
  }

  // ---------- keyboard wedge (DataWedge) ----------
  let buf = '';
  let start = 0;
  let last = 0;
  let target = null;
  let snapshot = null;

  function onKeyDown(e) {
    const now = performance.now();
    if (now - last > BURST_GAP_MS) {
      buf = '';
      start = now;
      target = document.activeElement;
      snapshot = isTextField(target) ? target.value : null;
    }
    last = now;
    if (e.key === 'Enter' || e.key === 'Tab') {
      const avg = (now - start) / Math.max(1, buf.length);
      if (buf.length >= WEDGE_MIN_LENGTH && avg <= WEDGE_MAX_AVG_MS) {
        e.preventDefault();
        e.stopPropagation();
        // The burst also landed in whatever field had focus — undo that; the
        // page decides where the scanned value should go.
        if (snapshot !== null && target && 'value' in target && target.value !== snapshot) {
          target.value = snapshot;
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const text = buf;
        buf = '';
        handler?.({ source: 'wedge', serial: '', text, field: isTextField(target) ? target : null });
      } else {
        buf = '';
      }
      return;
    }
    if (e.key.length === 1) buf += e.key;
  }
  document.addEventListener('keydown', onKeyDown, true);

  return {
    get nfcState() {
      return nfcState;
    },
    startNfc,
    autoStartNfc,
    writeUrl,
    setHandler(fn) {
      handler = fn;
    },
    stop() {
      abort?.abort();
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
}

// Haptic + audio feedback so workers wearing gloves know the scan registered.
let audio;
export function beep(ok = true) {
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = ok ? 1760 : 220;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + (ok ? 0.08 : 0.25));
  } catch {
    /* no audio: fine */
  }
}

// Same rules as the server's parseTagText, used when there's no signal so
// tags with data written on them (and QR labels) still work offline.
export function parseTagText(text) {
  const t = String(text ?? '').trim();
  const prefixed = /^(lift|battery|person)\s*[:=]\s*(.+)$/i.exec(t);
  if (prefixed) return { kind: prefixed[1].toLowerCase(), ref: prefixed[2].trim() };
  if (/^https?:\/\//i.test(t)) {
    try {
      const url = new URL(t);
      const m = /^\/(l|b)\/([^/]+)\/?$/.exec(url.pathname);
      if (m) return { kind: m[1] === 'l' ? 'lift' : 'battery', ref: decodeURIComponent(m[2]) };
      const lift = url.searchParams.get('lift');
      if (lift) return { kind: 'lift', ref: lift };
      const scan = url.searchParams.get('scan');
      if (scan) return parseTagText(scan);
    } catch {
      /* not a URL */
    }
  }
  return null;
}
