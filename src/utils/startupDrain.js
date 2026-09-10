/**
 * Startup DLQ Drain — src/utils/startupDrain.js
 *
 * Called once when the server starts (in server.js, after app.listen).
 * Replays any events that failed to sync while the server was down or while
 * the Tebra API was unavailable.
 *
 * ── Safety rules ─────────────────────────────────────────────────────────────
 *
 *   • Circuit OPEN  → drain is skipped entirely. Re-queueing is not needed
 *     because the queue file is unchanged. Drain will run on the next restart
 *     once credentials are fixed.
 *
 *   • Circuit opens MID-DRAIN (e.g. first event reveals bad credentials) →
 *     all remaining unprocessed entries are immediately re-enqueued and the
 *     drain stops. Zero additional API calls are made.
 *
 *   • After MAX_DLQ_ATTEMPTS failed drain passes for a single event → the
 *     event is moved to data/dlq_dead.json for manual review. It will never
 *     be automatically retried again.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   // server.js
 *   import { drainDLQ } from './utils/startupDrain.js';
 *   import { routeEvent } from './services/appointmentSyncService.js';
 *
 *   app.listen(PORT, async () => {
 *     console.log(`Server listening on port ${PORT}`);
 *     await drainDLQ(routeEvent);
 *   });
 */

import * as dlq from './dlq.js';
import * as circuitBreaker from './circuitBreaker.js';
import * as emailAlert from './emailAlert.js';

// Small pause between replayed events to avoid hitting Tebra rate limits.
// tebraClient's enforceMinSpacing() also protects this, but belt-and-suspenders.
const INTER_EVENT_DELAY_MS = 750;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drain the Dead Letter Queue and replay each event through routeEvent.
 *
 * @param {Function} routeEventFn  The routeEvent function from appointmentSyncService.js
 */
export async function drainDLQ(routeEventFn) {
  const queueDepth = await dlq.size();

  if (queueDepth === 0) {
    console.log('[dlq:drain] Queue empty — nothing to replay');
    return;
  }

  // ── Circuit check before starting ──────────────────────────────────────────
  const circuitState = await circuitBreaker.getState();
  if (circuitState === circuitBreaker.OPEN) {
    console.warn(
      `[dlq:drain] ⛔ Circuit OPEN — skipping drain of ${queueDepth} event(s).\n` +
      `            Fix credentials in .env → pm2 restart to retry.`
    );
    return;
  }

  if (circuitState === circuitBreaker.HALF_OPEN) {
    console.log(
      `[dlq:drain] Circuit HALF_OPEN — proceeding cautiously. ` +
      `First successful call will close the circuit.`
    );
  }

  // ── Drain ──────────────────────────────────────────────────────────────────
  const entries = await dlq.drain(); // clears queue file; we own the entries now
  console.log(`[dlq:drain] Starting replay of ${entries.length} event(s)...`);

  let succeeded = 0;
  let requeued = 0;
  let deadLettered = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // ── Mid-drain circuit check ─────────────────────────────────────────────
    if (await circuitBreaker.isOpen()) {
      console.warn(
        `[dlq:drain] ⛔ Circuit opened mid-drain after ${succeeded} successful replay(s). ` +
        `Re-queuing ${entries.length - i} remaining event(s).`
      );
      for (let j = i; j < entries.length; j++) {
        await dlq.enqueue(
          entries[j].normalizedEvent,
          'Circuit opened mid-drain — held for next restart',
          entries[j].attempts
        );
        requeued++;
      }
      break;
    }

    // ── Replay ─────────────────────────────────────────────────────────────
    try {
      await routeEventFn(entry.normalizedEvent);
      succeeded++;
      console.log(
        `[dlq:drain] ✅ Replayed ${entry.teamupEventId} (${entry.action}) ` +
        `[${i + 1}/${entries.length}]`
      );
    } catch (err) {
      const nextAttempts = entry.attempts + 1;

      if (nextAttempts > dlq.MAX_DLQ_ATTEMPTS) {
        await dlq.moveToDeadLetter(entry, err.message);
        deadLettered++;
      } else {
        console.warn(
          `[dlq:drain] Event ${entry.teamupEventId} failed again ` +
          `(attempt ${nextAttempts}/${dlq.MAX_DLQ_ATTEMPTS}): ${err.message} — re-queuing`
        );
        await dlq.enqueue(entry.normalizedEvent, err.message, nextAttempts);
        requeued++;
      }
    }

    // Pause between events (skip delay after the last one)
    if (i < entries.length - 1) {
      await delay(INTER_EVENT_DELAY_MS);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const finalDepth = await dlq.size();
  console.log(
    `[dlq:drain] Complete — ` +
    `✅ ${succeeded} replayed, ` +
    `🔄 ${requeued} re-queued, ` +
    `☠️  ${deadLettered} dead-lettered. ` +
    `Queue depth now: ${finalDepth}`
  );

  // Send summary email if anything was in the queue (no email when queue was empty)
  emailAlert.sendDrainSummaryAlert({ succeeded, requeued, deadLettered, queueDepth: finalDepth })
    .catch(err => console.error('[alert] Drain summary email dispatch failed:', err.message));
}
