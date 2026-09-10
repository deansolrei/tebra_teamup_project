// src/routes/suiteStatusRoute.js
//
// SolCore full-suite status route — added [DATE] to power the new "Engine Room"
// full-suite dashboard and the solcore-suite.30s.sh SwiftBar plugin.
//
// This is additive only. It does NOT touch /health or /status, which the
// existing Tebra Sync monitoring already uses and which keep working exactly
// as documented in the Teamup->Tebra manual.
//
// It reads the SAME circuit_breaker.json / dlq.json files that /status
// already uses (see Section 14, File Map) rather than re-implementing that
// logic, and shells out to `pm2 jlist`, `pg_isready`, and `pgrep` for the
// other services -- all read-only checks, nothing here can change service
// state.
//
// ── Install ──────────────────────────────────────────────────────────────
// 1. Save this file as: ~/tebra_teamup_project/src/routes/suiteStatusRoute.js
// 2. In src/server.js, add near the other route imports:
//      import suiteStatusRoute from './routes/suiteStatusRoute.js';
//    and near the other app.use(...) lines:
//      app.use('/status/suite', suiteStatusRoute);
// 3. Save suite-status.html (the companion file) into:
//      ~/tebra_teamup_project/public/suite-status.html
// 4. Restart: pm2 restart tebra-teamup-sync --update-env
// 5. Test: curl http://192.168.88.178:3001/status/suite/data
//
// Full step-by-step with copy-paste commands lives in the SolCore manual's
// Engine Room, under "Full-Suite Status Deployment."
//
// ── 2026-09-09 update ───────────────────────────────────────────────────
// Added a real health check for "Alex" (SolVoice), replacing the old check
// against the retired self-hosted agent. Alex now runs on Google Cloud Run
// (3 functions: send-billing-message, send-provider-message,
// send-intake-email), so this checks each service's deployment "Ready"
// condition via `gcloud run services describe`, in parallel, non-blocking,
// with a 2-minute cache so we're not hitting Google's API on every 30s poll.

import express from 'express';
import { execSync, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/routes/ -> project root -> data/
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const router = express.Router();

const GCLOUD = '/opt/homebrew/bin/gcloud';
const ALEX_SERVICES = ['send-billing-message', 'send-provider-message', 'send-intake-email'];
const ALEX_REGION = 'us-central1';
const ALEX_PROJECT = 'solrei-voice-agent';
const ALEX_CACHE_MS = 2 * 60 * 1000;
let alexCache = { result: null, checkedAt: 0 };

async function checkAlexService(serviceName) {
  try {
    const { stdout } = await execFileAsync(GCLOUD, [
      'run', 'services', 'describe', serviceName,
      '--region', ALEX_REGION,
      '--project', ALEX_PROJECT,
      '--format', 'json(status.conditions)',
    ], { timeout: 8000 });
    const parsed = JSON.parse(stdout);
    const ready = (parsed.status?.conditions || []).find((c) => c.type === 'Ready');
    return ready?.status === 'True';
  } catch {
    return false;
  }
}

async function checkAlex() {
  const now = Date.now();
  if (alexCache.result && (now - alexCache.checkedAt) < ALEX_CACHE_MS) {
    return alexCache.result;
  }
  const results = await Promise.all(
    ALEX_SERVICES.map(async (name) => ({ name, ready: await checkAlexService(name) }))
  );
  const notReady = results.filter((r) => !r.ready).map((r) => r.name);
  let result;
  if (notReady.length === 0) {
    result = { status: 'green', detail: 'all 3 Cloud Run services ready' };
  } else if (notReady.length === ALEX_SERVICES.length) {
    result = { status: 'red', detail: 'all Cloud Run services unreachable' };
  } else {
    result = { status: 'red', detail: `not ready: ${notReady.join(', ')}` };
  }
  alexCache = { result, checkedAt: now };
  return result;
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function getPm2Process(name) {
  try {
    const list = JSON.parse(execSync('pm2 jlist', { timeout: 5000 }).toString());
    return list.find((p) => p.name === name) || null;
  } catch {
    return null;
  }
}

function pm2StatusColor(proc, label) {
  if (!proc) return { status: 'red', detail: `${label}: not found in PM2` };
  const status = proc.pm2_env?.status;
  const restarts = proc.pm2_env?.restart_time ?? 0;
  // unstable_restarts is PM2's own crash-loop detector — it only counts restarts
  // that happen in rapid succession (before min_uptime elapses), and resets to 0
  // once the process has been stable for a while. This is a much better signal
  // than lifetime restart count, which grows forever from ordinary maintenance
  // restarts (code updates, rate imports, etc.) and never resets.
  const unstableRestarts = proc.pm2_env?.unstable_restarts ?? 0;
  if (status !== 'online') return { status: 'red', detail: `PM2 status: ${status}` };
  if (unstableRestarts > 0) {
    return {
      status: 'yellow',
      detail: `online, but ${unstableRestarts} unstable restart(s) recently — may be crash-looping`,
    };
  }
  return { status: 'green', detail: `online, ${restarts} restarts total (stable)` };
}

function checkPostgres() {
  try {
    execSync('pg_isready -q', { timeout: 5000 });
    return { status: 'green', detail: 'accepting connections' };
  } catch {
    return { status: 'red', detail: 'not accepting connections' };
  }
}

function checkCloudflareTunnel() {
  try {
    execSync('pgrep -x cloudflared', { timeout: 5000 });
    return { status: 'green', detail: 'process running' };
  } catch {
    return { status: 'red', detail: 'cloudflared process not found' };
  }
}

function checkTebraSync() {
  const circuit = readJsonSafe(path.join(DATA_DIR, 'circuit_breaker.json'), { state: 'UNKNOWN' });
  const dlq = readJsonSafe(path.join(DATA_DIR, 'dlq.json'), []);
  const queueDepth = Array.isArray(dlq) ? dlq.length : 0;

  if (circuit.state === 'OPEN') {
    return { status: 'red', detail: 'circuit OPEN — Tebra auth failure' };
  }
  if (queueDepth > 0) {
    return { status: 'yellow', detail: `${queueDepth} event(s) queued for replay` };
  }
  return { status: 'green', detail: 'circuit CLOSED, queue empty' };
}

function checkDisk() {
  try {
    const out = execSync("df -H / | tail -1 | awk '{print $5}'", { timeout: 5000 })
      .toString()
      .trim();
    const usedPct = parseInt(out.replace('%', ''), 10);
    if (Number.isNaN(usedPct)) return { status: 'unknown', detail: 'could not parse disk usage' };
    if (usedPct >= 90) return { status: 'red', detail: `${usedPct}% used` };
    if (usedPct >= 75) return { status: 'yellow', detail: `${usedPct}% used` };
    return { status: 'green', detail: `${usedPct}% used` };
  } catch {
    return { status: 'unknown', detail: 'could not read disk usage' };
  }
}

function worstOf(statuses) {
  if (statuses.includes('red')) return 'red';
  if (statuses.includes('yellow') || statuses.includes('unknown')) return 'yellow';
  return 'green';
}

// GET /status/suite/data — JSON, used by the web page and the SwiftBar plugin
router.get('/data', async (req, res) => {
  const services = {
    tebraSync: checkTebraSync(),
    solRate: pm2StatusColor(getPm2Process('cpt-dashboard'), 'SolRate'),
    alex: await checkAlex(),
    postgres: checkPostgres(),
    cloudflareTunnel: checkCloudflareTunnel(),
  };
  const disk = checkDisk();

  const overall = worstOf([...Object.values(services).map((s) => s.status), disk.status]);

  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    overall,
    services,
    host: {
      uptimeSeconds: Math.floor(process.uptime()),
      disk,
    },
  });
});

// GET /status/suite — the branded HTML dashboard page
router.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'suite-status.html'));
});

export default router;
