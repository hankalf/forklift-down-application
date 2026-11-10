# Forklift Down

A fast way for warehouse workers to report a forklift that is **down** or **needs repair**, and to log
**battery changes** and **charge levels**. Alerts go to the right people based on **which lift type it is**
and **what the problem is**. It's built for Raymond High Reach trucks, Linde reach trucks and dock trucks,
and runs on **Zebra scanners** (NFC tags and the scan trigger) or any phone.

- **Workers** tap a lift's NFC tag (or scan its QR code, or pick it from a list), tap what's wrong, tap
  *Down* or *Still runs*, and send. That's three taps after the scan, and no login.
- **Techs** get a text/email/Teams message with a link that opens the ticket. They can acknowledge it,
  mark it waiting on parts, or close it with one tap, without logging in.
- **Managers** see a live fleet board, open tickets, battery health, every alert sent, and downtime
  reports. They also set up who gets alerted for what.

## What's in it

| | |
|---|---|
| **Problem reports** | 13 problem types (brakes, hydraulics, mast/forks, leaks, error codes…), *Down* vs *Still runs*, optional notes, error code and photo. Safety problems (brakes, steering, forks, leaks, horn/alarms) push toward *Down* and remind the worker to tag the lift out. |
| **Duplicate control** | When a lift already has an open problem, the worker sees it and can tap *Same problem — add info*, which adds a note without re-alerting everyone. |
| **Alert rules** | Each rule matches on **event**, **lift type**, **problem type**, **severity** and an optional **shift window** (overnight shifts work). Alerts go out by **text (Twilio)**, **email (Resend or SMTP)** or a **Teams/Slack webhook**. If several rules match the same person, they still get one message per channel. The *Who gets alerted if…* preview shows the result of a rule change before it's live. |
| **Escalation** | If a DOWN lift isn't acknowledged in 15 minutes (you can change this), escalation rules fire (by default to the Operations Manager). |
| **Back-in-service alerts** | When a tech closes a ticket, the people who need to know get a "BACK IN SERVICE" message. |
| **Battery tracking** | Workers log battery swaps (battery out/in, charge %, hour meter) and charge readings (tap the % on the gauge). A low charge alerts the battery room. The dashboard shows the latest charge for each lift, which battery is in which lift, which batteries are out charging, and flags lifts with 3+ swaps in a day (a weak battery). |
| **NFC tags & Zebra scanners** | Tap a lift tag to open that lift. Tap battery tags to fill in *battery out/in*. Tap a badge to fill in your name. The scan trigger reads the printed QR labels and barcodes. See [Zebra scanners & NFC tags](#zebra-scanners--nfc-tags). |
| **Works in dead zones** | Steel racking kills Wi-Fi. Reports made without signal are saved on the device and sent automatically when it reconnects. Tags with a link written on them also work offline. |
| **QR labels** | Setup → Lifts → *Print all QR labels*. Each label opens that lift's report screen when scanned. |
| **Reports & export** | Problems, down hours, average time to acknowledge and to fix, and top problems for each lift type (compare Raymond vs Linde vs dock trucks and your dealers' response times). You can also export every ticket as CSV. |

## Deploy on Railway

1. **Create the service.** New Project → *Deploy from GitHub repo*, then pick this repo. Railway finds
   the `Dockerfile` and `railway.json`, which sets the `/healthz` health check and restart policy.
2. **Add a Volume.** This step is required, or the database is wiped on every deploy. Open the service and
   add a Volume with mount path **`/data`**. The app finds it automatically through `RAILWAY_VOLUME_MOUNT_PATH`.
3. **Generate a domain.** Go to Settings → Networking → *Generate Domain*. Ticket links and QR labels use
   it automatically through `RAILWAY_PUBLIC_DOMAIN`. If you use a custom domain, also set `PUBLIC_URL`.
4. **Set Variables:**

   | Variable | |
   |---|---|
   | `MANAGER_PIN` | PIN for `/manager`. |
   | `SESSION_SECRET` | Long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Keep it stable, or alert links stop working. |
   | `WORKER_PIN` | Site PIN each scanner/phone enters **once**. Strongly recommended: a Railway URL is on the public internet. |
   | `TZ` | e.g. `America/Chicago`. Sets the timezone for shift windows and the times in messages. |
   | `RESEND_API_KEY`, `EMAIL_FROM` | Email. **Railway blocks outbound SMTP on Free/Trial/Hobby plans**, so use [Resend](https://resend.com) (HTTPS). `EMAIL_FROM` must use a domain you verified in Resend. On the Pro plan you can use `SMTP_*` instead. |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Text messages. |
   | `SEED_DEMO` | `false` to start with an empty fleet instead of demo lifts R-01…, L-01…, D-01…. |

5. Keep it at **1 replica** (SQLite and the Volume require that) and leave **Serverless / app sleeping
   off**, so escalation checks keep running.

On first start the app creates starter **people** and **alert rules** (below). Then:

1. Go to `/manager` → **Setup → People** and add real phone numbers and emails. Use **Test** to check each one.
2. Go to **Setup → Lifts**, replace the demo lifts with your fleet, then print the QR labels and/or register NFC tags.
3. Go to **Setup → Alert rules** and adjust the rules. Use the preview to check them.

`.env.example` lists every setting.

## Zebra scanners & NFC tags

**Setting up a device** (TC2x/TC5x/TC7x, MC93…): open the Railway URL in **Chrome**, enter the site PIN,
and choose *⋮ → Add to Home screen*.

**NFC.** Zebra's DataWedge [can't read NFC tags](https://techdocs.zebra.com/datawedge/14-0/guide/faq), so
the app reads them itself with Chrome's Web NFC (Android + HTTPS, which Railway provides).

- The first time, tap **📶 Turn on NFC** in the top bar and allow it. After that it turns on by itself
  whenever the app opens.
- NFC must be on in Android settings. Hold the tag to the NFC spot on the back of the device.
- What a tap does:

  | Tag | Effect |
  |---|---|
  | Lift tag | Opens that lift. |
  | Battery tag | On the battery-change screen, fills *battery OUT*, then *IN*. The app uses what it knows: a battery it has recorded in this lift goes OUT, and one recorded as taken out to charge goes IN. A **⇅ Swap** button fixes a mix-up. On any other screen, it opens the lift that battery is in. |
  | Badge | Fills in your name. |

**Barcodes and QR codes with the trigger.** Use DataWedge's keyboard output (in Chrome's profile,
*Keystroke output* on, with *Basic data formatting → Send ENTER key* on). The app tells scans apart from
typing by speed. The printed QR labels, a barcode of a unit number (`R-03`), or a battery barcode all work.

**Tags to buy.** NTAG213/215/216 stickers. Use **on-metal (anti-metal)** tags on lifts and battery
cases, because ordinary tags won't read on steel.

**Registering tags.** On the Zebra, open `/manager` → **Setup → NFC tags**. Pick the lift (or battery
number, or person), press **Tap tag now**, and hold the tag to the device.

- The app records the tag's serial number. It can also **write a link onto the tag**, which is
  recommended: the tag then works offline, and any NFC phone that taps it opens the app.
- After each lift it moves on to the next one, so tagging a whole fleet is one tap per lift.
- Badges work if they are 13.56 MHz NFC with a readable ID. Many secure badges (HID iCLASS/SEOS,
  125 kHz prox) won't read; for those, stick an NFC tag on the badge. Either way, each device remembers
  the name it was last given.

## Starter alert rules

| Rule | Who | How |
|---|---|---|
| Any lift **DOWN** | Warehouse Manager, Maintenance Lead | text + email |
| **Needs repair** (still running) | Maintenance Lead | email |
| **Raymond High Reach** problems (+ escalations) | Raymond Dealer Service | text + email |
| **Linde Reach** problems (+ escalations) | Linde Dealer Service | text + email |
| **Dock truck** problems and fixes | Dock Supervisor | text |
| **Safety-critical** (brakes, steering, mast/forks, leaks, horn/alarm/deadman) | Safety Coordinator | text + email |
| Battery / won't-start problems | Battery Room | text |
| **Low charge** reported | Battery Room | text |
| DOWN **not acknowledged in time** | Operations Manager, Warehouse Manager | text + email |
| Lift **back in service** | Warehouse Manager | email |
| Every problem, escalation & fix | Shift Team Channel (Teams/Slack webhook) | webhook |

Starter people have no phone/email until you add them. Until then their alerts show as *skipped* in the
Alert log, and workers aren't told those people were alerted.

## Run locally

Requires Node 22.13+ (it uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
MANAGER_PIN=1234 npm start
```

Open http://localhost:3000 (worker app) and http://localhost:3000/manager (dashboard). With no
email/SMS configured, alerts are recorded in the Alert log as *logged (dry run)*, so you can try
everything safely.

```bash
npm test
```

## How it's built

- Node.js + Express 5, SQLite through the built-in `node:sqlite` (no native modules), and plain
  HTML/CSS/JS with no build step. The worker app is an installable PWA with an offline outbox.
- `src/rules.js`: the rules engine (pure functions). `src/notify/`: message formatting plus the
  Twilio/Resend/SMTP/webhook senders. `src/service.js`: reporting, battery, escalation and scan logic.
  `src/store.js`: database access.
- `public/app.js`: worker app. `public/scan.js`: Web NFC and keyboard-wedge scanning. `public/ticket.js`:
  tech ticket page. `public/manager.js`: dashboard.
- To add a lift type (e.g. order pickers), add it to `LIFT_TYPES` in `src/catalog.js`. It then shows up in
  the app, the dashboard and the rule editor.

## Security notes

- The manager dashboard needs `MANAGER_PIN`. With `WORKER_PIN` set, worker devices need the site PIN
  once (a signed, year-long cookie). Ten wrong PINs lock that IP out for 15 minutes.
- Alert links carry a signed per-ticket token. It opens and updates **only that ticket**. Treat alert
  messages like you would a door code.
- Photos are size- and type-checked and stored under random names.
