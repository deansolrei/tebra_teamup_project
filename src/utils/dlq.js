/**
 * Dead Letter Queue (DLQ) — src/utils/dlq.js
 *
 * When a Teamup event fails to sync to Tebra (API down, auth error, network
 * hiccup), it is saved here rather than silently dropped. On the next PM2
 * restart, startupDrain.js replays everything in the queue.
 *
 * Files written to:
 *   data/dlq.json       — active retry queue
 *   data/dlq_dead.json  — permanently failed events (manual review required)
 *
 * Each entry shape:
 * {
 *   id:              string   — unique entry ID (UUID)
 *   teamupEventId:   string   — Teamup's event ID
 *   action:          string   — 'create' | 'modify' | 'delete'
 *   failedAt:        string   — ISO timestamp of first failure
 *   failReason:      string   — error message
 *   attempts:        number   — how many drain passes have been tried
 *   normalizedEvent: object   — full normalized event passed to routeEvent()
 * }
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as emailAlert from './emailAlert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DLQ_PATH = path.join(DATA_DIR, 'dlq.json');
const DEAD_PATH = path.join(DATA_DIR, 'dlq_dead.json');

// An event that has failed this many drain attempts is moved to dlq_dead.json.
export const MAX_DLQ_ATTEMPTS = 3;

// ── File helpers ─────────────────────────────────────────────────────────────

async function readJson(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

async function writeJson(filePath, data) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a failed event to the retry queue.
 *
 * Idempotent: if an entry with the same teamupEventId + action already exists
 * in the queue, the duplicate is silently ignored (Teamup sometimes fires the
 * same webhook twice).
 *
 * @param {object} normalizedEvent  The full normalized event object (routeEvent input)
 * @param {string} failReason       Error message describing why it failed
 * @param {number} [attempts=1]     Drain attempt count (default 1 for new entries)
 */
export async function enqueue(normalizedEvent, failReason, attempts = 1) {
    const queue = await readJson(DLQ_PATH);

    const alreadyQueued = queue.some(
        e => e.teamupEventId === normalizedEvent.teamupEventId
            && e.action === normalizedEvent.action
    );

    if (alreadyQueued) {
        console.warn(
            `[dlq] Event ${normalizedEvent.teamupEventId} (${normalizedEvent.action}) already queued — skipping duplicate`
        );
        return;
    }

    const entry = {
        id: crypto.randomUUID(),
        teamupEventId: normalizedEvent.teamupEventId,
        action: normalizedEvent.action,
        failedAt: new Date().toISOString(),
        failReason,
        attempts,
        normalizedEvent,
    };

    queue.push(entry);
    await writeJson(DLQ_PATH, queue);

    console.log(
        `[dlq] Enqueued ${normalizedEvent.teamupEventId} (${normalizedEvent.action}) ` +
        `— queue depth: ${queue.length}`
    );
}

/**
 * Remove all entries from the active queue and return them.
 * The caller is responsible for re-enqueuing any entries that fail again.
 *
 * @returns {Array} All queued entries (may be empty)
 */
export async function drain() {
    const queue = await readJson(DLQ_PATH);
    if (queue.length === 0) return [];

    // Clear the file immediately — the drain loop re-enqueues failures individually.
    await writeJson(DLQ_PATH, []);
    console.log(`[dlq] Drained ${queue.length} event(s) for replay`);
    return queue;
}

/**
 * Move an entry to dlq_dead.json after exhausting all retry attempts.
 * These events need manual investigation.
 *
 * @param {object} entry      The DLQ entry that gave up
 * @param {string} lastError  Final error message
 */
export async function moveToDeadLetter(entry, lastError) {
    const dead = await readJson(DEAD_PATH);
    dead.push({
        ...entry,
        movedToDeadAt: new Date().toISOString(),
        lastError,
    });
    await writeJson(DEAD_PATH, dead);
    console.error(
        `[dlq] ☠️  Event ${entry.teamupEventId} dead-lettered after ${entry.attempts} attempts — ` +
        `check data/dlq_dead.json for manual review`
    );

    // Email alert — fire-and-forget, never throw
    emailAlert.sendDeadLetterAlert({ entry, lastError }).catch(err =>
        console.error('[alert] Dead-letter email dispatch failed:', err.message)
    );
}

/**
 * Current number of events waiting in the active queue.
 * Does not modify the queue.
 */
export async function size() {
    const queue = await readJson(DLQ_PATH);
    return queue.length;
}

/**
 * Inspect the queue without modifying it.
 * @returns {Array} All queued entries
 */
export async function peek() {
    return readJson(DLQ_PATH);
}

/**
 * Clear the dead-letter file (after manual resolution of dead-lettered events).
 * Use this deliberately — it permanently discards unsynced events.
 */
export async function clearDeadLetter() {
    await writeJson(DEAD_PATH, []);
    console.log('[dlq] Dead letter queue cleared');
}
