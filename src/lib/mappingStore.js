/**
 * mappingStore.js
 *
 * Flat-file JSON mapping store: teamup_event_id → tebra_appointment_id.
 * This is the dedup guarantee — every Teamup event maps to exactly one Tebra
 * appointment. A retried or duplicate webhook cannot create a second record
 * because teamupEventId is the primary key.
 *
 * File location: <project_root>/data/teamup_tebra_map.json
 * Created automatically on first write.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const MAP_FILE = path.join(DATA_DIR, 'teamup_tebra_map.json');

// ---- internal helpers -----------------------------------------------------

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(MAP_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  } catch {
    console.error('[mappingStore] Failed to parse map file — starting fresh');
    return {};
  }
}

function writeStore(store) {
  ensureDataDir();
  const tmp = MAP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, MAP_FILE);
}

// ---- public API -----------------------------------------------------------

/**
 * Look up an existing mapping by Teamup event ID.
 * Returns the record or null if not found.
 */
export function getMapping(teamupEventId) {
  const store = readStore();
  return store[teamupEventId] ?? null;
}

/**
 * Create or update a mapping record.
 *
 * @param {object} opts
 * @param {string} opts.teamupEventId
 * @param {string} [opts.tebraAppointmentId]
 * @param {number} opts.providerId
 * @param {number} opts.patientId
 * @param {string} opts.startUtc
 * @param {string} opts.endUtc
 * @param {string} opts.contentHash
 * @param {string} opts.sourceCalendarId
 * @param {string} [opts.status]  'active' | 'cancelled'
 */
export function upsertMapping(opts) {
  const store = readStore();
  const existing = store[opts.teamupEventId] ?? {};
  store[opts.teamupEventId] = {
    ...existing,
    teamupEventId: opts.teamupEventId,
    tebraAppointmentId: opts.tebraAppointmentId ?? existing.tebraAppointmentId ?? null,
    providerId: opts.providerId,
    patientId: opts.patientId,
    startUtc: opts.startUtc,
    endUtc: opts.endUtc,
    contentHash: opts.contentHash,
    sourceCalendarId: opts.sourceCalendarId,
    status: opts.status ?? 'active',
    lastSyncedAt: new Date().toISOString(),
    createdAt: existing.createdAt ?? new Date().toISOString(),
  };
  writeStore(store);
  return store[opts.teamupEventId];
}

/**
 * Mark a mapping as cancelled (after Tebra deletion/cancellation).
 */
export function markMappingCancelled(teamupEventId) {
  const store = readStore();
  if (!store[teamupEventId]) return null;
  store[teamupEventId] = {
    ...store[teamupEventId],
    status: 'cancelled',
    lastSyncedAt: new Date().toISOString(),
  };
  writeStore(store);
  return store[teamupEventId];
}

/**
 * Hash the scheduling-relevant fields of a normalized Teamup event.
 * Used to skip Tebra updates when nothing meaningful changed.
 *
 * PRIVACY NOTE: title is intentionally excluded. Tebra appointments always
 * show "JJ Block" regardless of the Teamup event title, so a title change
 * on Teamup should NOT trigger a Tebra update. Only time changes matter.
 */
export function hashEventContent(teamupEvent) {
  const relevant = {
    startsAt: teamupEvent.startsAt,
    endsAt: teamupEvent.endsAt,
    // title deliberately omitted — not used in Tebra output
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(relevant))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Return all mapping records (for diagnostics).
 */
export function getAllMappings() {
  return readStore();
}
