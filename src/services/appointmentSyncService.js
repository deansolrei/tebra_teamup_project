/**
 * appointmentSyncService.js
 *
 * One-way sync: Teamup → Tebra (Jodene Jensen / JJ Block only).
 *
 * routeEvent is the single entry point. It:
 *   1. Looks up the existing mapping (dedup key = teamupEventId).
 *   2. For create/updated:
 *      - If no mapping exists → create Tebra appointment + persist mapping.
 *      - If mapping exists but content changed → update Tebra appointment.
 *      - If mapping exists and content unchanged → no-op (handles retried webhooks).
 *   3. For deleted/cancelled → cancel the mapped Tebra appointment.
 *
 * SYNC_DRY_RUN=true logs what would happen without touching Tebra.
 */

import { config } from '../config.js';
import {
  buildJodeneCreatePayload,
  buildJodeneUpdatePayload,
} from '../mappings/jodene.js';
import {
  createAppointment,
  updateAppointment,
  deleteAppointment,
} from '../clients/tebraClient.js';
import {
  getMapping,
  upsertMapping,
  markMappingCancelled,
  hashEventContent,
} from '../lib/mappingStore.js';

// ---- fixed pilot constants ------------------------------------------------
const PHASE1 = {
  providerId: 1,
  patientId: 901,
  parentCalendarKey: 'i5eg7g',       // top-level Teamup calendar (payload.calendar)
  sourceSubcalendarId: 12333159,     // subcalendar ID as it appears in webhook event payloads
};

// ---- main entry point -----------------------------------------------------

/**
 * Route a normalized Teamup event to the correct Tebra operation.
 *
 * @param {object} teamupEvent - output of normalizeTeamupEvent()
 * @returns {Promise<object>} result summary
 */
export async function routeEvent(teamupEvent) {
  const { teamupEventId, eventType } = teamupEvent;

  const existing = getMapping(teamupEventId);

  switch (eventType) {
    case 'created':
    case 'updated': {
      const contentHash = hashEventContent(teamupEvent);

      if (!existing) {
        // No mapping → treat as new appointment regardless of event type.
        // Guards against a modify arriving before the create was processed.
        return await _createTebraAppointment(teamupEvent, contentHash);
      }

      if (existing.status === 'cancelled') {
        return {
          action: 'skipped',
          reason: 'Mapping exists but status is cancelled — not re-creating',
          teamupEventId,
          existing,
        };
      }

      if (existing.contentHash === contentHash) {
        // Identical content — no-op (handles duplicate/retried webhooks)
        return {
          action: 'no-op',
          reason: 'Content unchanged',
          teamupEventId,
          tebraAppointmentId: existing.tebraAppointmentId,
        };
      }

      // Content changed → update the mapped Tebra appointment
      return await _updateTebraAppointment(teamupEvent, existing, contentHash);
    }

    case 'deleted':
    case 'cancelled': {
      if (!existing || !existing.tebraAppointmentId) {
        return {
          action: 'skipped',
          reason: 'No active Tebra appointment mapping found — nothing to cancel',
          teamupEventId,
        };
      }

      if (existing.status === 'cancelled') {
        return {
          action: 'no-op',
          reason: 'Already cancelled',
          teamupEventId,
          tebraAppointmentId: existing.tebraAppointmentId,
        };
      }

      return await _cancelTebraAppointment(teamupEvent, existing);
    }

    default:
      return {
        action: 'ignored',
        reason: `Unrecognized event type: ${eventType}`,
        teamupEventId,
      };
  }
}

// ---- private operation helpers --------------------------------------------

async function _createTebraAppointment(teamupEvent, contentHash) {
  const payload = buildJodeneCreatePayload(teamupEvent);

  if (config.sync.dryRun) {
    console.log('[DRY RUN] Would create Tebra appointment:', JSON.stringify(payload, null, 2));
    const record = upsertMapping({
      teamupEventId: teamupEvent.teamupEventId,
      tebraAppointmentId: 'DRY-RUN',
      providerId: PHASE1.providerId,
      patientId: PHASE1.patientId,
      startUtc: teamupEvent.startsAt,
      endUtc: teamupEvent.endsAt,
      contentHash,
      sourceCalendarId: teamupEvent.subcalendarId || teamupEvent.calendarId,
      status: 'active',
    });
    return { action: 'dry-run-create', payload, mapping: record };
  }

  const createResponse = await createAppointment(payload);
  const tebraAppointmentId = extractCreatedAppointmentId(createResponse);

  const record = upsertMapping({
    teamupEventId: teamupEvent.teamupEventId,
    tebraAppointmentId,
    providerId: PHASE1.providerId,
    patientId: PHASE1.patientId,
    startUtc: teamupEvent.startsAt,
    endUtc: teamupEvent.endsAt,
    contentHash,
    sourceCalendarId: teamupEvent.subcalendarId || teamupEvent.calendarId,
    status: 'active',
  });

  console.log(`[routeEvent] Created Tebra appointment ${tebraAppointmentId} for Teamup event ${teamupEvent.teamupEventId}`);
  return { action: 'created', tebraAppointmentId, createResponse, mapping: record };
}

async function _updateTebraAppointment(teamupEvent, existing, contentHash) {
  const payload = buildJodeneUpdatePayload(teamupEvent, existing.tebraAppointmentId);

  if (config.sync.dryRun) {
    console.log('[DRY RUN] Would update Tebra appointment:', existing.tebraAppointmentId, JSON.stringify(payload, null, 2));
    const record = upsertMapping({
      teamupEventId: teamupEvent.teamupEventId,
      tebraAppointmentId: existing.tebraAppointmentId,
      providerId: PHASE1.providerId,
      patientId: PHASE1.patientId,
      startUtc: teamupEvent.startsAt,
      endUtc: teamupEvent.endsAt,
      contentHash,
      sourceCalendarId: teamupEvent.subcalendarId || teamupEvent.calendarId,
      status: 'active',
    });
    return { action: 'dry-run-update', payload, mapping: record };
  }

  const updateResponse = await updateAppointment(payload);

  const record = upsertMapping({
    teamupEventId: teamupEvent.teamupEventId,
    tebraAppointmentId: existing.tebraAppointmentId,
    providerId: PHASE1.providerId,
    patientId: PHASE1.patientId,
    startUtc: teamupEvent.startsAt,
    endUtc: teamupEvent.endsAt,
    contentHash,
    sourceCalendarId: teamupEvent.subcalendarId || teamupEvent.calendarId,
    status: 'active',
  });

  console.log(`[routeEvent] Updated Tebra appointment ${existing.tebraAppointmentId} for Teamup event ${teamupEvent.teamupEventId}`);
  return { action: 'updated', tebraAppointmentId: existing.tebraAppointmentId, updateResponse, mapping: record };
}

async function _cancelTebraAppointment(teamupEvent, existing) {
  if (config.sync.dryRun) {
    console.log('[DRY RUN] Would cancel Tebra appointment:', existing.tebraAppointmentId);
    markMappingCancelled(teamupEvent.teamupEventId);
    return { action: 'dry-run-cancel', tebraAppointmentId: existing.tebraAppointmentId };
  }

  const deleteResponse = await deleteAppointment(existing.tebraAppointmentId);
  markMappingCancelled(teamupEvent.teamupEventId);

  console.log(`[routeEvent] Cancelled Tebra appointment ${existing.tebraAppointmentId} for Teamup event ${teamupEvent.teamupEventId}`);
  return { action: 'cancelled', tebraAppointmentId: existing.tebraAppointmentId, deleteResponse };
}

// ---- ID extraction --------------------------------------------------------

function extractCreatedAppointmentId(response) {
  if (!response) return null;

  const direct = deepFindFirstValueByKey(response, [
    'AppointmentID',
    'AppointmentId',
    'appointmentId',
    'ID',
    'Id',
    'id',
  ]);

  if (direct && /^\d+$/.test(String(direct))) return String(direct);

  try {
    const s = JSON.stringify(response);
    const match = s.match(/"(?:AppointmentID|AppointmentId|appointmentId|ID|Id|id)":"?(\d+)"?/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function deepFindFirstValueByKey(input, keys) {
  if (input == null) return null;
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = deepFindFirstValueByKey(item, keys);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof input !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] != null) {
      if (typeof input[key] !== 'object') return input[key];
    }
  }
  for (const value of Object.values(input)) {
    const found = deepFindFirstValueByKey(value, keys);
    if (found != null) return found;
  }
  return null;
}
