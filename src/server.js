import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { teamupWebhookRouter } from './routes/teamupWebhookRoute.js';
import suiteStatusRoute from './routes/suiteStatusRoute.js';
import { drainDLQ } from './utils/startupDrain.js';
import { routeEvent } from './services/appointmentSyncService.js';
import * as circuit from './utils/circuitBreaker.js';
import * as dlq from './utils/dlq.js';

const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

// Allow cross-origin requests for status endpoints
// (needed for the status widget embedded in other tools on different ports)
app.use('/health', cors());
app.use('/status', cors());

// Enhanced health check — exposes circuit state and DLQ depth
app.get('/health', async (req, res) => {
  try {
    const circuitState = await circuit.getState();
    const dlqDepth = await dlq.size();
    const isHealthy = circuitState === 'CLOSED' && dlqDepth === 0;

    res.status(isHealthy ? 200 : 503).json({
      ok: isHealthy,
      circuit: circuitState,   // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
      dlqDepth,                  // events pending replay
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live status dashboard — open in any browser on the clinic network
app.get('/status', async (req, res) => {
  try {
    const circuitState = await circuit.getState();
    const circuitFull = await circuit.status();
    const dlqDepth = await dlq.size();
    const dlqEntries = await dlq.peek();
    const isHealthy = circuitState === 'CLOSED' && dlqDepth === 0;

    const stateColor = {
      CLOSED: { bg: '#16a34a', label: '✅ CLOSED — Normal', desc: 'All Tebra API calls passing through normally.' },
      OPEN: { bg: '#dc2626', label: '⛔ OPEN — Blocked', desc: 'All Tebra API calls blocked. Fix credentials and restart PM2.' },
      HALF_OPEN: { bg: '#d97706', label: '⚠️ HALF_OPEN — Testing', desc: 'Cooldown elapsed. Next call is a test — success closes circuit.' },
    }[circuitState] ?? { bg: '#6b7280', label: circuitState, desc: '' };

    const dlqRows = dlqEntries.length === 0
      ? '<p style="color:#16a34a;font-weight:600">✅ Queue is empty — no pending events.</p>'
      : `<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
          <tr style="background:#f1f5f9">
            <th style="padding:8px;text-align:left">Event ID</th>
            <th style="padding:8px;text-align:left">Action</th>
            <th style="padding:8px;text-align:left">Attempts</th>
            <th style="padding:8px;text-align:left">First Failed</th>
            <th style="padding:8px;text-align:left">Reason</th>
          </tr>
          ${dlqEntries.map(e => `
            <tr style="border-top:1px solid #e2e8f0">
              <td style="padding:8px"><code>${e.teamupEventId}</code></td>
              <td style="padding:8px">${e.action}</td>
              <td style="padding:8px">${e.attempts} / 3</td>
              <td style="padding:8px">${e.failedAt ? new Date(e.failedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '—'}</td>
              <td style="padding:8px;color:#dc2626;font-size:12px">${e.failReason ?? '—'}</td>
            </tr>`).join('')}
        </table>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>SBH Sync Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
    .header { background: #1a2744; color: white; padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 20px; font-weight: 700; }
    .body { max-width: 820px; margin: 32px auto; padding: 0 20px; }
    .card { background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .card h2 { font-size: 13px; font-weight: 700; margin-bottom: 16px; color: #475569; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge { display: inline-block; padding: 10px 18px; border-radius: 8px; font-size: 15px; font-weight: 700; color: white; background: ${stateColor.bg}; margin-bottom: 10px; }
    .meta { font-size: 13px; color: #64748b; margin-top: 10px; }
    .meta span { margin-right: 20px; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .note { text-align: center; font-size: 12px; color: #94a3b8; margin-top: 24px; padding-bottom: 40px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🖥️ SBH Tebra Sync — Live Status</h1>
      <div style="font-size:12px;opacity:0.6;margin-top:4px">sbhserver1 · sync.solreibehavioralhealth.com · auto-refreshes every 30 sec</div>
    </div>
    <div style="font-size:28px">${isHealthy ? '✅' : '🔴'}</div>
  </div>

  <div class="body">
    <div class="card">
      <h2>Circuit Breaker</h2>
      <div class="badge">${stateColor.label}</div>
      <p style="font-size:14px;color:#475569;margin-top:8px">${stateColor.desc}</p>
      <div class="meta">
        <span>Failures: <strong>${circuitFull.failureCount} / ${circuitFull.failureThreshold}</strong></span>
        ${circuitState === 'OPEN' ? `<span>Cooldown remaining: <strong>${Math.ceil((circuitFull.cooldownRemaining || 0) / 1000)}s</strong></span>` : ''}
        ${circuitFull.openedAt ? `<span>Opened: <strong>${new Date(circuitFull.openedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })}</strong></span>` : ''}
      </div>
    </div>

    <div class="card">
      <h2>Dead Letter Queue
        <span style="background:${dlqDepth > 0 ? '#fef2f2' : '#f0fdf4'};color:${dlqDepth > 0 ? '#dc2626' : '#16a34a'};padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;margin-left:8px">
          ${dlqDepth} event${dlqDepth !== 1 ? 's' : ''}
        </span>
      </h2>
      ${dlqRows}
    </div>

    <div class="card">
      <h2>Quick Commands</h2>
      <div style="font-size:13px;line-height:2.2">
        <div>View logs: <code>pm2 logs tebra-teamup-sync --lines 30</code></div>
        <div>Restart &amp; drain queue: <code>pm2 restart tebra-teamup-sync</code></div>
        <div>Edit credentials: <code>nano ~/tebra_teamup_project/.env</code></div>
        <div>Dead letter file: <code>cat ~/tebra_teamup_project/data/dlq_dead.json</code></div>
      </div>
    </div>
  </div>

  <div class="note">Auto-refreshes every 30 seconds · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<pre>Status page error: ${err.message}</pre>`);
  }
});

app.use('/webhooks/teamup', teamupWebhookRouter);
app.use('/status/suite', suiteStatusRoute);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', { message: err.message, stack: err.stack });
  res.status(500).json({ ok: false, error: 'Unhandled server error' });
});

app.listen(config.app.port, async () => {
  console.log(`Server listening on port ${config.app.port}`);
  console.log(`Teamup webhook endpoint: /webhooks/teamup`);
  await drainDLQ(routeEvent);
});
