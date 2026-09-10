/**
 * Circuit Breaker — src/utils/circuitBreaker.js
 *
 * Prevents Tebra account lockouts by stopping ALL API calls the moment bad
 * credentials are detected. Without this, a backed-up DLQ could fire dozens
 * of auth attempts in rapid succession — exactly how lockouts happen.
 *
 * ── States ───────────────────────────────────────────────────────────────────
 *
 *   CLOSED     Normal. All Tebra calls pass through.
 *
 *   OPEN       Blocked. All Tebra calls are rejected immediately without
 *              touching the API. No lockout risk. Triggered by:
 *                • Any auth failure          (1 strike — immediate)
 *                • FAILURE_THRESHOLD non-auth failures in a row
 *
 *   HALF_OPEN  Cooldown elapsed. One test call is allowed through. If it
 *              succeeds → CLOSED. If it fails → OPEN again (reset timer).
 *
 * ── Persistence ──────────────────────────────────────────────────────────────
 *
 *   State is written to data/circuit_breaker.json so a PM2 restart respects
 *   an open circuit — the DLQ drain won't immediately hammer a still-broken API.
 *
 * ── Typical Auth Failure Flow ────────────────────────────────────────────────
 *
 *   1. Tebra rejects credentials → callWithRetry calls recordAuthFailure()
 *   2. Circuit opens immediately, alert email sent
 *   3. All subsequent calls (including DLQ drain) → blocked, zero API hits
 *   4. Admin fixes TEBRA_PASSWORD in .env → pm2 restart
 *   5. startupDrain checks circuit → HALF_OPEN (cooldown elapsed) or OPEN (re-queues)
 *   6. First successful call → circuit CLOSED → DLQ drains normally
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import * as emailAlert from './emailAlert.js';
import * as dlq from './dlq.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH  = path.resolve(__dirname, '../../data/circuit_breaker.json');

export const CLOSED    = 'CLOSED';
export const OPEN      = 'OPEN';
export const HALF_OPEN = 'HALF_OPEN';

// Number of consecutive non-auth failures before the circuit opens.
const FAILURE_THRESHOLD = 5;

// How long the circuit stays OPEN before moving to HALF_OPEN (allowing a test call).
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ── In-memory state (loaded from disk on first use) ───────────────────────────

let _state        = CLOSED;
let _failureCount = 0;
let _openedAt     = null;   // ISO string of when circuit last opened
let _loaded       = false;

// ── Disk I/O ──────────────────────────────────────────────────────────────────

async function load() {
  if (_loaded) return;
  try {
    const raw    = await fs.readFile(STATE_PATH, 'utf-8');
    const saved  = JSON.parse(raw);
    _state        = saved.state        ?? CLOSED;
    _failureCount = saved.failureCount ?? 0;
    _openedAt     = saved.openedAt     ?? null;

    // If persisted OPEN but cooldown elapsed since then → HALF_OPEN
    if (_state === OPEN && _openedAt) {
      const elapsed = Date.now() - new Date(_openedAt).getTime();
      if (elapsed >= COOLDOWN_MS) {
        _state = HALF_OPEN;
      }
    }
    console.log(`[circuit] Loaded state: ${_state} (consecutive failures: ${_failureCount})`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[circuit] Could not read state file — starting CLOSED:', err.message);
    }
    // No file → start fresh in CLOSED
  }
  _loaded = true;
}

async function persist() {
  try {
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify({
      state:        _state,
      failureCount: _failureCount,
      openedAt:     _openedAt,
      updatedAt:    new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.error('[circuit] Failed to persist state:', err.message);
  }
}

function openCircuit(reason) {
  _state    = OPEN;
  _openedAt = new Date().toISOString();
  console.error(
    `[circuit] ⛔ OPEN — ${reason}\n` +
    `          All Tebra API calls blocked for ${COOLDOWN_MS / 60000} min.\n` +
    `          Fix credentials in .env → pm2 restart to recover.`
  );
  persist(); // fire-and-forget — don't await in a sync context
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Current circuit state, accounting for cooldown expiry.
 * @returns {Promise<'CLOSED'|'OPEN'|'HALF_OPEN'>}
 */
export async function getState() {
  await load();
  // Re-evaluate OPEN → HALF_OPEN if cooldown has elapsed
  if (_state === OPEN && _openedAt) {
    const elapsed = Date.now() - new Date(_openedAt).getTime();
    if (elapsed >= COOLDOWN_MS) {
      _state = HALF_OPEN;
      console.log('[circuit] Cooldown elapsed → HALF_OPEN (one test call allowed)');
      await persist();
    }
  }
  return _state;
}

/**
 * Returns true if calls should be blocked (OPEN state).
 * Returns false for both CLOSED and HALF_OPEN.
 */
export async function isOpen() {
  const s = await getState();
  return s === OPEN;
}

/**
 * Returns true if circuit is in test mode (HALF_OPEN).
 */
export async function isHalfOpen() {
  const s = await getState();
  return s === HALF_OPEN;
}

/**
 * Record a successful Tebra API call.
 * Closes the circuit and resets the failure counter.
 */
export async function recordSuccess() {
  await load();
  if (_state !== CLOSED) {
    console.log(`[circuit] ✅ Success — circuit CLOSED (was ${_state})`);
  }
  _state        = CLOSED;
  _failureCount = 0;
  _openedAt     = null;
  await persist();
}

/**
 * Record an authentication failure (wrong credentials / expired password).
 * Opens the circuit IMMEDIATELY — never retry bad credentials.
 * This is the primary lockout-prevention mechanism.
 *
 * Also sends the auth-failure alert email, including the current DLQ depth
 * so whoever gets the email knows how many appointments are safely queued
 * rather than lost.
 *
 * @param {string} [operationName] The Tebra operation that failed (e.g. 'CreateAppointment')
 */
export async function recordAuthFailure(operationName = 'Tebra API') {
  await load();
  openCircuit(`AUTH FAILURE on ${operationName} — Tebra rejected credentials. Update TEBRA_PASSWORD in .env.`);

  try {
    const queueDepth = await dlq.size();
    emailAlert.sendAuthFailureAlert({ operationName, queueDepth }).catch((err) =>
      console.error('[alert] Auth-failure email dispatch failed:', err.message)
    );
  } catch (err) {
    // Never let alerting failures affect circuit-breaker behavior.
    console.error('[circuit] Could not dispatch auth-failure alert:', err.message);
  }
}

/**
 * Record a non-auth, non-rate-limit failure.
 * Opens the circuit after FAILURE_THRESHOLD consecutive failures.
 *
 * @param {string} [reason] Error description for logging
 */
export async function recordFailure(reason = 'unknown error') {
  await load();
  _failureCount++;
  console.warn(`[circuit] Failure ${_failureCount}/${FAILURE_THRESHOLD}: ${reason}`);
  if (_failureCount >= FAILURE_THRESHOLD) {
    openCircuit(`${FAILURE_THRESHOLD} consecutive failures — last: ${reason}`);
  } else {
    await persist();
  }
}

/**
 * Manually reset circuit to CLOSED.
 * Normally not needed (reset happens automatically on first successful call),
 * but useful for admin scripts or testing.
 */
export async function reset() {
  await load();
  console.log('[circuit] Manual reset → CLOSED');
  _state        = CLOSED;
  _failureCount = 0;
  _openedAt     = null;
  await persist();
}

/**
 * Full status snapshot for health checks / monitoring.
 * @returns {Promise<object>}
 */
export async function status() {
  await load();
  const state = await getState(); // evaluates cooldown
  return {
    state,
    failureCount:      _failureCount,
    failureThreshold:  FAILURE_THRESHOLD,
    openedAt:          _openedAt,
    cooldownMs:        COOLDOWN_MS,
    cooldownRemaining: (_state === OPEN && _openedAt)
      ? Math.max(0, COOLDOWN_MS - (Date.now() - new Date(_openedAt).getTime()))
      : 0,
  };
}
