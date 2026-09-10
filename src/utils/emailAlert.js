/**
 * Email Alert Utility — src/utils/emailAlert.js
 *
 * Sends HTML email notifications for critical Tebra sync events.
 * Uses Nodemailer + Gmail SMTP (App Password auth — no 2FA prompts).
 *
 * Required .env variables:
 *   GMAIL_USER=dean@solreibehavioralhealth.com
 *   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
 *
 * Optional .env variables:
 *   ALERT_TO_EMAIL=dean@solreibehavioralhealth.com   (defaults to GMAIL_USER)
 *   EMAIL_ALERTS_ENABLED=true                        (defaults to true; set false to silence)
 *
 * Three alert types:
 *   sendAuthFailureAlert()   — circuit opened due to bad credentials
 *   sendDeadLetterAlert()    — event permanently failed after 3 drain attempts
 *   sendDrainSummaryAlert()  — startup drain completed with queued events
 *
 * Safety features:
 *   - Never throws: email failures are logged but never crash the sync service
 *   - Dedup window: identical alerts are suppressed for 15 minutes to prevent spam
 *     (e.g. rapid PM2 restarts won't flood your inbox)
 */

import nodemailer from 'nodemailer';

// ── Dedup / rate limiting ──────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const _sentAt = new Map();               // dedupKey → timestamp

function isDuplicate(key) {
    const last = _sentAt.get(key);
    return last !== undefined && Date.now() - last < DEDUP_WINDOW_MS;
}

function markSent(key) {
    _sentAt.set(key, Date.now());
    // Prune stale entries so the map doesn't grow forever
    for (const [k, t] of _sentAt.entries()) {
        if (Date.now() - t > DEDUP_WINDOW_MS * 2) _sentAt.delete(k);
    }
}

// ── Transport ──────────────────────────────────────────────────────────────────

function createTransport() {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) return null;
    return nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
    });
}

// ── Core send function ─────────────────────────────────────────────────────────

async function send({ subject, html, dedupKey }) {
    // Respect EMAIL_ALERTS_ENABLED flag (default: true)
    if (process.env.EMAIL_ALERTS_ENABLED === 'false') return;

    if (dedupKey && isDuplicate(dedupKey)) {
        console.log(`[alert] Suppressing duplicate alert (key: ${dedupKey}) — will re-send after 15 min`);
        return;
    }

    const transport = createTransport();
    if (!transport) {
        console.warn(
            '[alert] Email not configured — add GMAIL_USER and GMAIL_APP_PASSWORD to .env\n' +
            `[alert] Would have sent: "${subject}"`
        );
        return;
    }

    const from = process.env.GMAIL_USER;
    const to = process.env.ALERT_TO_EMAIL || from;

    try {
        await transport.sendMail({ from, to, subject, html });
        console.log(`[alert] ✉️  Sent: "${subject}" → ${to}`);
        if (dedupKey) markSent(dedupKey);
    } catch (err) {
        // Log and swallow — never let email failure crash the sync service
        console.error(`[alert] Failed to send "${subject}": ${err.message}`);
    }
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function nowET() {
    return new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' ET';
}

function footer() {
    return `
    <p style="color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px">
      SBH Server · sbhserver1 · sync.solreibehavioralhealth.com · ${nowET()}
    </p>
  `;
}

// ── Alert 1: Auth failure / circuit open ──────────────────────────────────────

/**
 * Sent immediately when Tebra rejects credentials and the circuit opens.
 *
 * @param {object} opts
 * @param {string} [opts.operationName]  The Tebra operation that failed (e.g. 'CreateAppointment')
 * @param {number} [opts.queueDepth]     How many events are now queued in the DLQ
 */
export async function sendAuthFailureAlert({ operationName = 'Tebra API', queueDepth = 0 } = {}) {
    await send({
        dedupKey: 'auth-failure',
        subject: '⚠️ SBH Tebra Sync — Credentials Rejected, Sync Paused',
        html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#dc2626;color:white;padding:24px 28px;border-radius:10px 10px 0 0">
          <div style="font-size:28px;margin-bottom:6px">⚠️</div>
          <h2 style="margin:0;font-size:20px">Tebra Sync Paused — Action Required</h2>
          <p style="margin:6px 0 0;opacity:0.85;font-size:14px">The circuit breaker opened. No Tebra API calls are being made.</p>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-top:none;padding:24px 28px;border-radius:0 0 10px 10px">

          <h3 style="color:#dc2626;margin-top:0">What happened</h3>
          <p>Tebra rejected the stored credentials during <strong>${operationName}</strong>. To prevent account lockouts, the circuit breaker has opened and is blocking all further Tebra API calls until credentials are fixed.</p>

          <div style="background:white;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0">
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:5px 0;color:#6b7280;width:160px">Failed operation</td><td style="padding:5px 0;font-weight:600">${operationName}</td></tr>
              <tr><td style="padding:5px 0;color:#6b7280">Circuit state</td><td style="padding:5px 0;font-weight:600;color:#dc2626">OPEN — all calls blocked</td></tr>
              <tr><td style="padding:5px 0;color:#6b7280">Queued events</td><td style="padding:5px 0;font-weight:600">${queueDepth} appointment(s) saved for replay</td></tr>
            </table>
          </div>

          <h3 style="color:#dc2626">How to fix it (5 steps)</h3>
          <ol style="font-size:14px;line-height:1.8">
            <li>SSH in: <code style="background:#fee2e2;padding:2px 6px;border-radius:4px">ssh sbhserver1@192.168.88.178</code></li>
            <li>Open the credentials file: <code style="background:#fee2e2;padding:2px 6px;border-radius:4px">nano ~/tebra_teamup_project/.env</code></li>
            <li>Update the line: <code style="background:#fee2e2;padding:2px 6px;border-radius:4px">TEBRA_PASSWORD=your_correct_password</code></li>
            <li>Save and exit: <code style="background:#fee2e2;padding:2px 6px;border-radius:4px">Ctrl+O → Enter → Ctrl+X</code></li>
            <li>Restart the service: <code style="background:#fee2e2;padding:2px 6px;border-radius:4px">pm2 restart tebra-teamup-sync</code></li>
          </ol>

          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin-top:16px">
            <strong style="color:#15803d">✅ No appointments are lost</strong>
            <p style="color:#166534;font-size:14px;margin:6px 0 0">${queueDepth} event(s) are safely saved in the Dead Letter Queue and will sync to Tebra automatically the moment the service restarts with correct credentials. You will receive a follow-up email confirming how many appointments were recovered.</p>
          </div>

          ${footer()}
        </div>
      </div>
    `,
    });
}

// ── Alert 2: Dead-lettered event ───────────────────────────────────────────────

/**
 * Sent when an event exhausts all retry attempts and is moved to dlq_dead.json.
 *
 * @param {object} opts
 * @param {object} opts.entry      The full DLQ entry object
 * @param {string} opts.lastError  The final error message
 */
export async function sendDeadLetterAlert({ entry = {}, lastError = 'unknown' } = {}) {
    const eventId = entry.teamupEventId ?? 'unknown';
    const action = entry.action ?? 'unknown';
    const attempts = entry.attempts ?? 0;
    const failedAt = entry.failedAt ?? 'unknown';
    const title = entry.normalizedEvent?.title ?? '(no title)';
    const start = entry.normalizedEvent?.startUtc ?? '';

    await send({
        dedupKey: `dead-letter-${eventId}-${action}`,
        subject: `☠️ SBH Tebra Sync — Appointment Failed After ${attempts} Attempts (Manual Review Needed)`,
        html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#7c3aed;color:white;padding:24px 28px;border-radius:10px 10px 0 0">
          <div style="font-size:28px;margin-bottom:6px">☠️</div>
          <h2 style="margin:0;font-size:20px">Sync Event Permanently Failed</h2>
          <p style="margin:6px 0 0;opacity:0.85;font-size:14px">Manual review required — this event will not retry automatically.</p>
        </div>
        <div style="background:#faf5ff;border:1px solid #e9d5ff;border-top:none;padding:24px 28px;border-radius:0 0 10px 10px">

          <h3 style="color:#7c3aed;margin-top:0">What happened</h3>
          <p>A Teamup event failed to sync to Tebra across <strong>${attempts} separate restart attempts</strong>. After exhausting all retries, it has been moved to <code>data/dlq_dead.json</code> for manual review.</p>

          <div style="background:white;border:1px solid #e9d5ff;border-radius:8px;padding:16px;margin:16px 0">
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr style="background:#f5f3ff"><td style="padding:7px 10px;color:#6b7280;width:140px">Event title</td><td style="padding:7px 10px;font-weight:600">${title}</td></tr>
              <tr><td style="padding:7px 10px;color:#6b7280">Teamup event ID</td><td style="padding:7px 10px"><code>${eventId}</code></td></tr>
              <tr style="background:#f5f3ff"><td style="padding:7px 10px;color:#6b7280">Action</td><td style="padding:7px 10px">${action}</td></tr>
              <tr><td style="padding:7px 10px;color:#6b7280">Start time</td><td style="padding:7px 10px">${start}</td></tr>
              <tr style="background:#f5f3ff"><td style="padding:7px 10px;color:#6b7280">First failed</td><td style="padding:7px 10px">${failedAt}</td></tr>
              <tr><td style="padding:7px 10px;color:#6b7280">Attempts</td><td style="padding:7px 10px">${attempts} of 3</td></tr>
              <tr style="background:#fef2f2"><td style="padding:7px 10px;color:#dc2626;font-weight:700">Last error</td><td style="padding:7px 10px;color:#dc2626"><code>${lastError}</code></td></tr>
            </table>
          </div>

          <h3 style="color:#7c3aed">How to resolve it</h3>
          <ol style="font-size:14px;line-height:1.8">
            <li>Review the dead letter file:<br><code style="background:#ede9fe;padding:2px 6px;border-radius:4px">cat ~/tebra_teamup_project/data/dlq_dead.json</code></li>
            <li>Identify and fix the root cause from the <strong>Last error</strong> above</li>
            <li>If the appointment is still needed: <strong>recreate the event in Teamup</strong> — the sync service will pick it up automatically</li>
            <li>After resolving, clear the dead letter file:<br><code style="background:#ede9fe;padding:2px 6px;border-radius:4px">echo "[]" > ~/tebra_teamup_project/data/dlq_dead.json</code></li>
          </ol>

          ${footer()}
        </div>
      </div>
    `,
    });
}

// ── Alert 3: Startup drain summary ────────────────────────────────────────────

/**
 * Sent after startupDrain completes, but only if there were events to replay.
 * (No email is sent if the queue was empty — no news is good news.)
 *
 * @param {object} opts
 * @param {number} opts.succeeded      Events successfully synced to Tebra
 * @param {number} opts.requeued       Events that failed again and are back in queue
 * @param {number} opts.deadLettered   Events moved to permanent dead letter
 * @param {number} opts.queueDepth     Remaining queue depth after drain
 */
export async function sendDrainSummaryAlert({ succeeded = 0, requeued = 0, deadLettered = 0, queueDepth = 0 } = {}) {
    // Don't send anything if there was nothing to report
    if (succeeded === 0 && requeued === 0 && deadLettered === 0) return;

    const allGood = deadLettered === 0 && requeued === 0;
    const headerBg = allGood ? '#16a34a' : deadLettered > 0 ? '#dc2626' : '#d97706';
    const bodyBg = allGood ? '#f0fdf4' : deadLettered > 0 ? '#fef2f2' : '#fffbeb';
    const borderColor = allGood ? '#bbf7d0' : deadLettered > 0 ? '#fecaca' : '#fde68a';
    const emoji = allGood ? '✅' : deadLettered > 0 ? '⚠️' : '🔄';
    const headline = allGood
        ? `${succeeded} Queued Appointment(s) Recovered Successfully`
        : `Sync Recovery — ${succeeded} Recovered, ${deadLettered > 0 ? deadLettered + ' Need Attention' : requeued + ' Still Pending'}`;

    await send({
        dedupKey: 'drain-summary',
        subject: `${emoji} SBH Tebra Sync — ${headline}`,
        html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto">
        <div style="background:${headerBg};color:white;padding:24px 28px;border-radius:10px 10px 0 0">
          <div style="font-size:28px;margin-bottom:6px">${emoji}</div>
          <h2 style="margin:0;font-size:20px">Startup Sync Recovery Complete</h2>
          <p style="margin:6px 0 0;opacity:0.85;font-size:14px">sbhserver1 replayed the Dead Letter Queue on restart.</p>
        </div>
        <div style="background:${bodyBg};border:1px solid ${borderColor};border-top:none;padding:24px 28px;border-radius:0 0 10px 10px">

          <table style="width:100%;border-collapse:collapse;font-size:15px;margin:0 0 20px">
            <tr style="background:rgba(0,0,0,0.04)">
              <td style="padding:12px 14px;font-weight:700">✅ Synced to Tebra successfully</td>
              <td style="padding:12px 14px;text-align:right;font-size:22px;font-weight:800;color:#16a34a">${succeeded}</td>
            </tr>
            <tr>
              <td style="padding:12px 14px;font-weight:700">🔄 Re-queued (will retry next restart)</td>
              <td style="padding:12px 14px;text-align:right;font-size:22px;font-weight:800;color:#d97706">${requeued}</td>
            </tr>
            <tr style="background:rgba(0,0,0,0.04)">
              <td style="padding:12px 14px;font-weight:700">☠️ Dead-lettered (manual review needed)</td>
              <td style="padding:12px 14px;text-align:right;font-size:22px;font-weight:800;color:#dc2626">${deadLettered}</td>
            </tr>
          </table>

          ${allGood ? `
            <div style="background:white;border:1px solid ${borderColor};border-radius:8px;padding:14px">
              <strong style="color:#15803d">All appointments recovered — no action needed.</strong>
              <p style="color:#166534;font-size:14px;margin:6px 0 0">Every event that queued up during the outage has been successfully synced to Tebra. Jodene's calendar is up to date.</p>
            </div>
          ` : ''}

          ${deadLettered > 0 ? `
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-top:12px">
              <strong style="color:#dc2626">Action needed: ${deadLettered} event(s) require manual review</strong>
              <p style="color:#991b1b;font-size:14px;margin:6px 0 0">Check <code>data/dlq_dead.json</code> on sbhserver1 for details. If those appointments are still needed, recreate them in Teamup.</p>
            </div>
          ` : ''}

          ${requeued > 0 ? `
            <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px;margin-top:12px">
              <strong style="color:#92400e">${requeued} event(s) are still queued</strong>
              <p style="color:#78350f;font-size:14px;margin:6px 0 0">They will retry on the next restart. Current queue depth: ${queueDepth}.</p>
            </div>
          ` : ''}

          ${footer()}
        </div>
      </div>
    `,
    });
}
