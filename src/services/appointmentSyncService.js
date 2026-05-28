import { withTransaction } from './db.js';
import {
  createAppointment,
  updateAppointment,
  cancelAppointment,
} from './tebraSoapClient.js';

const DEFAULT_PRACTICE_ID = 1;
const DEFAULT_PRACTICE_NAME = 'Solrei Behavioral Health, Inc.';
const DEFAULT_SERVICE_LOCATION_ID = 22;
const DEFAULT_SERVICE_LOCATION_NAME = 'AAA Test Service Location';

export async function processTeamupWebhook(event) {
  return withTransaction(async (client) => {
    await client.query(
      `insert into webhook_deliveries
        (source_system, delivery_id, event_type, raw_payload, processing_status)
       values ($1, $2, $3, $4, 'received')
       on conflict (source_system, delivery_id) do nothing`,
      ['teamup', event.deliveryId, event.eventType, event.raw]
    );

    const mappingResult = await client.query(
      `select * from event_mappings where teamup_event_id = $1 limit 1`,
      [event.teamupEventId]
    );
    let mapping = mappingResult.rows[0];

    const originToken = buildOriginToken(
      'teamup',
      event.teamupEventId,
      event.updatedAt || event.startsAt
    );

    if (mapping?.last_origin_token === originToken) {
      await markProcessed(client, event.deliveryId);
      return { ok: true, skipped: true, reason: 'duplicate origin token' };
    }

    if (event.eventType === 'created' && !mapping) {
      const inserted = await client.query(
        `insert into event_mappings
          (teamup_event_id, tebra_appointment_id, teamup_calendar_id, teamup_subcalendar_id,
           sync_direction, sync_status, last_origin_system, last_origin_token, last_synced_at)
         values ($1, $2, $3, $4, 'teamup_to_tebra', 'pending', 'teamup', $5, now())
         returning *`,
        [
          event.teamupEventId,
          null,
          event.calendarId || null,
          event.subcalendarId || null,
          originToken,
        ]
      );
      mapping = inserted.rows[0];
    }

    if (event.eventType === 'updated' && (!mapping || !mapping.tebra_appointment_id)) {
      if (mapping?.id) {
        await client.query(
          `update event_mappings
           set sync_status = 'updated_unmapped',
               last_origin_system = 'teamup',
               last_origin_token = $2,
               last_synced_at = now(),
               updated_at = now()
           where id = $1`,
          [mapping.id, originToken]
        );
      }

      await writeAuditLog(client, {
        mappingId: mapping?.id || null,
        direction: 'teamup_to_tebra',
        operation: 'updated',
        sourceSystem: 'teamup',
        destinationSystem: 'tebra',
        requestPayload: {
          deliveryId: event.deliveryId,
          teamupEventId: event.teamupEventId,
          eventType: event.eventType,
          title: event.title || null,
          startsAt: event.startsAt || null,
          endsAt: event.endsAt || null,
          reason: 'No tebra_appointment_id mapped; update skipped',
        },
        responsePayload: null,
        succeeded: true,
      });

      await markProcessed(client, event.deliveryId);
      return { ok: true, skipped: true, reason: 'no tebra_appointment_id' };
    }

    if ((event.eventType === 'deleted' || event.eventType === 'cancelled') && !mapping) {
      await writeAuditLog(client, {
        mappingId: null,
        direction: 'teamup_to_tebra',
        operation: event.eventType,
        sourceSystem: 'teamup',
        destinationSystem: 'tebra',
        requestPayload: {
          deliveryId: event.deliveryId,
          teamupEventId: event.teamupEventId,
          reason: 'No mapping exists; cancellation skipped',
        },
        responsePayload: null,
        succeeded: true,
      });

      await markProcessed(client, event.deliveryId);
      return { ok: true, skipped: true, reason: 'no mapping' };
    }

    const appointmentInput = await buildTebraAppointmentInput(client, event, mapping);

    if (event.eventType === 'created' && !appointmentInput.appointmentReasonId) {
      await client.query(
        `update event_mappings
         set sync_status = 'pending_reason_mapping',
             last_origin_system = 'teamup',
             last_origin_token = $2,
             last_synced_at = now(),
             updated_at = now()
         where id = $1`,
        [mapping.id, originToken]
      );

      await writeAuditLog(client, {
        mappingId: mapping.id,
        direction: 'teamup_to_tebra',
        operation: 'created',
        sourceSystem: 'teamup',
        destinationSystem: 'tebra',
        requestPayload: sanitizeRequestPayload(event, appointmentInput),
        responsePayload: {
          skipped: true,
          reason: 'Unable to resolve AppointmentReasonID',
          appointmentName: appointmentInput.appointmentName,
          startTime: appointmentInput.startTime,
          endTime: appointmentInput.endTime,
        },
        succeeded: true,
      });

      await markProcessed(client, event.deliveryId);
      return { ok: true, skipped: true, reason: 'missing appointmentReasonId' };
    }

    if (event.eventType === 'created') {
      const tebraResponse = await createAppointment(appointmentInput);
      const tebraAppointmentId = extractAppointmentId(tebraResponse);

      await client.query(
        `update event_mappings
         set tebra_appointment_id = $2,
             sync_status = 'synced',
             last_origin_system = 'teamup',
             last_origin_token = $3,
             last_synced_at = now(),
             updated_at = now()
         where id = $1`,
        [mapping.id, tebraAppointmentId, originToken]
      );

      await writeAuditLog(client, {
        mappingId: mapping.id,
        direction: 'teamup_to_tebra',
        operation: 'created',
        sourceSystem: 'teamup',
        destinationSystem: 'tebra',
        requestPayload: sanitizeRequestPayload(event, appointmentInput),
        responsePayload: tebraResponse,
        succeeded: true,
      });

      await markProcessed(client, event.deliveryId);
      return { ok: true, created: true, tebraAppointmentId };
    }

    if (event.eventType === 'updated') {
      const tebraResponse = await updateAppointment({
        ...appointmentInput,
        appointmentId: mapping.tebra_appointment_id,
      });

      await client.query(
        `update event_mappings
         set sync_status = 'synced',
             last_origin_system = 'teamup',
             last_origin_token = $2,
             last_synced_at = now(),
             updated_at = now()
         where id = $1`,
        [mapping.id, originToken]
      );

      await writeAuditLog(client, {
        mappingId: mapping.id,
        direction: 'teamup_to_tebra',
        operation: 'updated',
        sourceSystem: 'teamup',
        destinationSystem: 'tebra',
        requestPayload: sanitizeRequestPayload(event, {
          ...appointmentInput,
          appointmentId: mapping.tebra_appointment_id,
        }),
        responsePayload: tebraResponse,
        succeeded: true,
      });

      await markProcessed(client, event.deliveryId);
      return { ok: true, updated: true, tebraAppointmentId: mapping.tebra_appointment_id };
    }

    if (event.eventType === 'deleted' || event.eventType === 'cancelled') {
      if (!mapping?.tebra_appointment_id) {
        await client.query(
          `update event_mappings
           set sync_status = 'cancelled_no_tebra_id',
               last_origin_system = 'teamup',
               last_origin_token = $2,
               last_synced_at = now(),
               updated_at = now()
           where id = $1`,
          [mapping?.id, originToken]
        );

        await writeAuditLog(client, {
          mappingId: mapping?.id || null,
          direction: 'teamup_to_tebra',
          operation: event.eventType,
          sourceSystem: 'teamup',
          destinationSystem: 'tebra',
          requestPayload: {
            deliveryId: event.deliveryId,
            teamupEventId: event.teamupEventId,
            reason: 'No tebra_appointment_id on mapping; cancellation skipped',
          },
          responsePayload: null,
          succeeded: true,
        });

        await markProcessed(client, event.deliveryId);
        return { ok: true, skipped: true, reason: 'no tebra_appointment_id' };
      }

      const tebraResponse = await cancelAppointment({
        appointmentId: mapping.tebra_appointment_id,
        serviceLocationId: appointmentInput.serviceLocationId,
        startTime: appointmentInput.startTime,
        endTime: appointmentInput.endTime,
        appointmentReasonId: appointmentInput.appointmentReasonId,
        providerId: appointmentInput.providerId,
        resourceId: appointmentInput.resourceId,
        patientId: appointmentInput.patientId,
        resourceIds: appointmentInput.resourceIds,
        notes: appointmentInput.notes,
        appointmentName: appointmentInput.appointmentName,
        maxAttendees: appointmentInput.maxAttendees,
        isGroupAppointment: appointmentInput.isGroupAppointment,
        insurancePolicyAuthorizationId: appointmentInput.insurancePolicyAuthorizationId,
        patientCaseId: appointmentInput.patientCaseId,
        appointmentMode: appointmentInput.appointmentMode,
        ticketNumber: appointmentInput.ticketNumber,
      });

      await client.query(
        `update event_mappings
         set sync_status = 'cancelled_in_tebra',
             last_origin_system = 'teamup',
             last_origin_token = $2,
             last_synced_at = now(),
             updated_at = now()
         where id = $1`,
        [mapping.id, originToken]
      );

      await writeAuditLog(client, {
        mappingId: mapping.id,
        direction: 'teamup_to_tebra',
        operation: event.eventType,
        sourceSystem: 'teamup',
        destinationSystem: 'tebra',
        requestPayload: sanitizeRequestPayload(event, {
          appointmentId: mapping.tebra_appointment_id,
          appointmentStatus: 'Cancelled',
          serviceLocationId: appointmentInput.serviceLocationId,
          startTime: appointmentInput.startTime,
          endTime: appointmentInput.endTime,
          appointmentReasonId: appointmentInput.appointmentReasonId,
          providerId: appointmentInput.providerId,
          resourceId: appointmentInput.resourceId,
          patientId: appointmentInput.patientId,
          resourceIds: appointmentInput.resourceIds,
          notes: appointmentInput.notes,
          appointmentName: appointmentInput.appointmentName,
          appointmentMode: appointmentInput.appointmentMode,
        }),
        responsePayload: tebraResponse,
        succeeded: true,
      });

      await markProcessed(client, event.deliveryId);
      return { ok: true, cancelled: true, tebraAppointmentId: mapping.tebra_appointment_id };
    }

    await writeAuditLog(client, {
      mappingId: mapping?.id || null,
      direction: 'teamup_to_tebra',
      operation: event.eventType,
      sourceSystem: 'teamup',
      destinationSystem: 'tebra',
      requestPayload: {
        deliveryId: event.deliveryId,
        teamupEventId: event.teamupEventId,
        unsupportedEventType: event.eventType,
      },
      responsePayload: null,
      succeeded: true,
    });

    await markProcessed(client, event.deliveryId);
    return { ok: true, skipped: true, reason: 'unsupported event type' };
  });
}

async function buildTebraAppointmentInput(client, event, mapping) {
  const providerId = await resolveProviderId(client, event, mapping);
  const appointmentReasonId = await resolveAppointmentReasonId(client, event, mapping);
  const patientId = await resolvePatientId(client, event, mapping);
  const resourceId = await resolveResourceId(client, event, mapping);
  const resourceIds = await resolveResourceIds(client, event, mapping);
  const patientCaseId = await resolvePatientCaseId(client, event, mapping);
  const insurancePolicyAuthorizationId = await resolveInsurancePolicyAuthorizationId(client, event, mapping);

  return {
    practiceId: DEFAULT_PRACTICE_ID,
    practiceName: DEFAULT_PRACTICE_NAME,
    serviceLocationId: DEFAULT_SERVICE_LOCATION_ID,
    serviceLocationName: DEFAULT_SERVICE_LOCATION_NAME,
    startTime: event.startsAt,
    endTime: event.endsAt,
    appointmentStatus: 'Scheduled',
    appointmentReasonId,
    providerId,
    resourceId,
    resourceIds,
    patientId,
    patientCaseId,
    insurancePolicyAuthorizationId,
    appointmentName: event.title || 'Teamup Appointment',
    notes: buildAppointmentNotes(event),
    appointmentType: 'P',
    appointmentMode: 'Telehealth',
    isGroupAppointment: false,
    maxAttendees: 1,
    wasCreatedOnline: false,
  };
}

function buildAppointmentNotes(event) {
  const parts = [
    event.title ? `Teamup title: ${event.title}` : null,
    event.teamupEventId ? `Teamup event ID: ${event.teamupEventId}` : null,
    event.calendarId ? `Calendar ID: ${event.calendarId}` : null,
    event.subcalendarId ? `Subcalendar ID: ${event.subcalendarId}` : null,
  ].filter(Boolean);

  return parts.join('\n');
}

function extractAppointmentId(response) {
  return (
    response?.CreateAppointmentResult?.AppointmentID ||
    response?.CreateAppointmentResult?.AppointmentId ||
    response?.AppointmentID ||
    response?.AppointmentId ||
    response?.ID ||
    null
  );
}

function sanitizeRequestPayload(event, tebraPayload) {
  return {
    deliveryId: event.deliveryId,
    teamupEventId: event.teamupEventId,
    eventType: event.eventType,
    calendarId: event.calendarId || null,
    subcalendarId: event.subcalendarId || null,
    startsAt: event.startsAt || null,
    endsAt: event.endsAt || null,
    title: event.title || null,
    tebraPayload,
  };
}

async function markProcessed(client, deliveryId) {
  await client.query(
    `update webhook_deliveries
     set processing_status = 'processed', processed_at = now()
     where source_system = 'teamup' and delivery_id = $1`,
    [deliveryId]
  );
}

async function writeAuditLog(client, log) {
  await client.query(
    `insert into sync_audit_log
      (mapping_id, direction, operation, source_system, destination_system,
       request_payload, response_payload, succeeded, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      log.mappingId,
      log.direction,
      log.operation,
      log.sourceSystem,
      log.destinationSystem,
      log.requestPayload || null,
      log.responsePayload || null,
      log.succeeded ?? false,
    ]
  );
}

function buildOriginToken(system, id, modifiedAt) {
  return `${system}:${id}:${modifiedAt || new Date().toISOString()}`;
}

async function resolveProviderId(client, event, mapping) {
  return null;
}

async function resolveAppointmentReasonId(client, event, mapping) {
  return null;
}

async function resolvePatientId(client, event, mapping) {
  return null;
}

async function resolveResourceId(client, event, mapping) {
  return null;
}

async function resolveResourceIds(client, event, mapping) {
  return undefined;
}

async function resolvePatientCaseId(client, event, mapping) {
  return null;
}

async function resolveInsurancePolicyAuthorizationId(client, event, mapping) {
  return null;
}
