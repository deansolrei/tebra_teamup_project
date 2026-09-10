import { getMapping, upsertMapping, markMappingCancelled, hashEventContent } from '../lib/mappingStore.js';
import { createAppointment, updateAppointment, deleteAppointment } from '../clients/tebraClient.js';
import { buildJodeneCreatePayload, buildJodeneUpdatePayload } from '../mappings/jodene.js';
import { buildKatieCreatePayload, buildKatieUpdatePayload } from '../mappings/katie.js';
import { buildLoriCreatePayload, buildLoriUpdatePayload } from '../mappings/lori.js';
import { config } from '../config.js';
function extractAppointmentId(soapResult) {
  if (!soapResult || typeof soapResult !== 'object') return null;
  for (const val of Object.values(soapResult)) {
    if (typeof val === 'object') {
      const found = extractAppointmentId(val);
      if (found) return found;
    }
    if (typeof val === 'string' && /^\d+$/.test(val)) {
      const parent = Object.keys(soapResult).find(k => soapResult[k] === val);
      if (parent === 'AppointmentId') return val;
    }
  }
  return null;
}
// ─── Provider Registry ────────────────────────────────────────────────────────
const PROVIDER_REGISTRY = {
  12333159: {
    providerName: 'Jodene Jensen',
    providerId: 1,
    patientId: 675,
    buildCreate: buildJodeneCreatePayload,
    buildUpdate: buildJodeneUpdatePayload,
  },
  13976774: {
    providerName: 'Katherine Robins',
    providerId: 2,
    patientId: 905,
    buildCreate: buildKatieCreatePayload,
    buildUpdate: buildKatieUpdatePayload,
  },
  14920229: {
    providerName: 'Lori Kistler',
    providerId: 4,
    patientId: 903,
    buildCreate: buildLoriCreatePayload,
    buildUpdate: buildLoriUpdatePayload,
  },
};
// ─── Main entry point ─────────────────────────────────────────────────────────
export async function routeEvent(teamupEvent) {
  const subcalendarId = teamupEvent.subcalendarId;
  const provider = PROVIDER_REGISTRY[subcalendarId];
  if (!provider) {
    console.log(`[sync] No provider registered for subcalendar ${subcalendarId} — skipping.`);
    return;
  }
  console.log(`[sync] Routing event ${teamupEvent.teamupEventId} → ${provider.providerName} (action: ${teamupEvent.action})`);
  try {
    switch (teamupEvent.eventType) {
      case 'created':
      case 'updated':
        await handleCreateOrUpdate(teamupEvent, provider);
        break;
      case 'deleted':
      case 'cancelled':
        await handleDelete(teamupEvent, provider);
        break;
      default:
        console.log(`[sync] Unknown action "${teamupEvent.action}" — skipping.`);
    }
  } catch (err) {
    console.error(`[sync] Error processing event ${teamupEvent.teamupEventId}:`, err.message);
    throw err;
  }
}
// ─── Create or Update ─────────────────────────────────────────────────────────
async function handleCreateOrUpdate(teamupEvent, provider) {
  const existing = await getMapping(teamupEvent.teamupEventId);
  const hash = hashEventContent(teamupEvent);
  const needsCreate = !existing || !existing.tebraAppointmentId;
  if (needsCreate) {
    if (config.sync.dryRun) {
      console.log(`[sync][DRY-RUN] Would create appointment for event ${teamupEvent.teamupEventId}`);
      await upsertMapping({
        teamupEventId: teamupEvent.teamupEventId,
        tebraAppointmentId: null,
        providerId: provider.providerId,
        patientId: provider.patientId,
        startUtc: teamupEvent.startsAt,
        endUtc: teamupEvent.endsAt,
        contentHash: hash,
        status: 'DRY-RUN',
        sourceCalendarId: String(teamupEvent.subcalendarId),
      });
      return;
    }
    const payload = provider.buildCreate(teamupEvent);
    const soapResult = await createAppointment(payload);
    const tebraId = extractAppointmentId(soapResult);
    if (!tebraId) {
      console.error('[sync] Could not extract AppointmentId from create response:', JSON.stringify(soapResult).slice(0, 500));
      return;
    }
    console.log(`[sync] Created Tebra appointment ${tebraId} for event ${teamupEvent.teamupEventId} (${provider.providerName})`);
    await upsertMapping({
      teamupEventId: teamupEvent.teamupEventId,
      tebraAppointmentId: tebraId,
      providerId: provider.providerId,
      patientId: provider.patientId,
      startUtc: teamupEvent.startsAt,
      endUtc: teamupEvent.endsAt,
      contentHash: hash,
      status: 'active',
      sourceCalendarId: String(teamupEvent.subcalendarId),
    });
  } else if (existing.contentHash !== hash) {
    if (config.sync.dryRun) {
      console.log(`[sync][DRY-RUN] Would update appointment ${existing.tebraAppointmentId} for event ${teamupEvent.teamupEventId}`);
      return;
    }
    const payload = provider.buildUpdate(teamupEvent, existing.tebraAppointmentId);
    await updateAppointment(payload);
    console.log(`[sync] Updated Tebra appointment ${existing.tebraAppointmentId} for event ${teamupEvent.teamupEventId} (${provider.providerName})`);
    await upsertMapping({
      teamupEventId: teamupEvent.teamupEventId,
      tebraAppointmentId: existing.tebraAppointmentId,
      providerId: provider.providerId,
      patientId: provider.patientId,
      startUtc: teamupEvent.startsAt,
      endUtc: teamupEvent.endsAt,
      contentHash: hash,
      status: 'active',
      sourceCalendarId: String(teamupEvent.subcalendarId),
    });
  } else {
    console.log(`[sync] Event ${teamupEvent.teamupEventId} unchanged — no-op.`);
  }
}
// ─── Delete / Cancel ──────────────────────────────────────────────────────────
// ─── Delete / Cancel ──────────────────────────────────────────────────────────
async function handleDelete(teamupEvent, provider) {
  const existing = await getMapping(teamupEvent.teamupEventId);
  if (!existing?.tebraAppointmentId) {
    console.log(`[sync] No Tebra appointment found for deleted event ${teamupEvent.teamupEventId} — skipping.`);
    return;
  }
  if (existing.status === 'cancelled') {
    console.log(`[sync] Event ${teamupEvent.teamupEventId} already cancelled in Tebra — no-op.`);
    return;
  }
  if (config.sync.dryRun) {
    console.log(`[sync][DRY-RUN] Would delete appointment ${existing.tebraAppointmentId} for event ${teamupEvent.teamupEventId}`);
    return;
  }
  try {
    await deleteAppointment(existing.tebraAppointmentId);
  } catch (err) {
    // Tebra 404s here (NotFoundException on its internal ID-translation step)
    // mean the appointment is already gone — an earlier successful delete, a
    // manual removal, etc. Same end state as a successful delete, so treat it
    // as success instead of a permanent DLQ failure. Any OTHER error (auth,
    // network, rate limit, a real API problem) still throws normally and
    // gets retried/DLQ'd exactly as before — this only swallows the specific
    // "nothing to delete" case.
    const alreadyGone = err.message?.includes('NotFoundException') && err.message?.includes('errorCode":404');
    if (!alreadyGone) throw err;
    console.log(`[sync] Tebra appointment ${existing.tebraAppointmentId} already gone (404) for event ${teamupEvent.teamupEventId} — treating as deleted.`);
  }
  await markMappingCancelled(teamupEvent.teamupEventId);
  console.log(`[sync] Deleted Tebra appointment ${existing.tebraAppointmentId} for event ${teamupEvent.teamupEventId} (${provider.providerName})`);
}
