import { config } from '../config.js';
import { toUtcIso } from '../utils/time.js';

// NOTE: This builds the `Appointment` (AppointmentCreate) data contract only.
// It does NOT build RequestHeader — that auth header (ClientVersion, CustomerKey,
// Password, User) is assembled in tebraClient.js and is where field-order matters
// for authentication.
//
// AppointmentCreate is an <xs:sequence> with elementFormDefault="qualified", so
// the *order* of these fields matters if the serializer preserves key order.
// Keys below are ordered to match the WSDL AppointmentCreate sequence.

// Lori Kistler's blocked-time appointments are represented in Tebra by a
// dedicated placeholder patient (PatientID 903).
const LORI_BLOCK_PATIENT_NAME = 'LK Block';
const LORI_BLOCK_PATIENT_ID = 903;

const LORI_MAPPING = {
    // ---- identifiers / metadata used by the client to look things up ----
    providerName: 'Lori Kistler',
    practiceId: Number(config.tebra.practiceId),
    practiceName: config.tebra.practiceName,
    serviceLocationId: Number(config.tebra.serviceLocationId),
    serviceLocationName: config.tebra.serviceLocationName,

    // ---- AppointmentCreate fields ----
    appointmentReasonId: 107,
    appointmentStatus: 'Scheduled',
    appointmentType: 'P',
    appointmentMode: 'Telehealth',
    isRecurring: false,
    patientId: LORI_BLOCK_PATIENT_ID,
    providerId: 4,
    resourceId: 0,       // ← verify this matches Lori's resource in Tebra admin
    resourceIds: [0],
    wasCreatedOnline: false,
};

export function buildLoriCreatePayload(teamupEvent) {
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    // PRIVACY: AppointmentName is ALWAYS the placeholder patient name — never the Teamup event title.
    const appointmentName = `${marker} | ${LORI_BLOCK_PATIENT_NAME}`.slice(0, 100);
    const patientSummary = {
        patientId: LORI_BLOCK_PATIENT_ID,
        firstName: 'LK',
        lastName: 'Block',
    };

    return {
        ...LORI_MAPPING,
        appointmentName,
        startTime: startsAtUtc,
        endTime: endsAtUtc,
        patientSummary,
        recurrenceRule: null,
        notes: [
            marker,
            `TeamupEventID=${teamupId}`,
            `SourceStartUTC=${startsAtUtc}`,
            `SourceEndUTC=${endsAtUtc}`,
        ].join(' | '),
    };
}

export function buildLoriUpdatePayload(teamupEvent, tebraAppointmentId) {
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    return {
        appointmentId: tebraAppointmentId,
        appointmentMode: LORI_MAPPING.appointmentMode,
        appointmentName: `${marker} | ${LORI_BLOCK_PATIENT_NAME}`.slice(0, 100),
        appointmentReasonId: LORI_MAPPING.appointmentReasonId,
        appointmentStatus: LORI_MAPPING.appointmentStatus,
        appointmentType: LORI_MAPPING.appointmentType,
        endTime: endsAtUtc,
        isRecurring: LORI_MAPPING.isRecurring,
        notes: [
            marker,
            `TeamupEventID=${teamupId}`,
            `SourceStartUTC=${startsAtUtc}`,
            `SourceEndUTC=${endsAtUtc}`,
        ].join(' | '),
        patientId: LORI_BLOCK_PATIENT_ID,
        practiceId: LORI_MAPPING.practiceId,
        providerId: LORI_MAPPING.providerId,
        resourceId: 0,
        serviceLocationId: LORI_MAPPING.serviceLocationId,
        startTime: startsAtUtc,
    };
}

export function buildLoriVerificationFilter(teamupEvent) {
    const start = new Date(teamupEvent.startsAt);
    const end = new Date(teamupEvent.endsAt);

    const from = new Date(start.getTime() - 60 * 60 * 1000);
    const to = new Date(end.getTime() + 60 * 60 * 1000);

    return {
        practiceName: config.tebra.practiceName,
        serviceLocationName: config.tebra.serviceLocationName,
        patientId: LORI_BLOCK_PATIENT_ID,
        startDate: toUtcIso(from),
        endDate: toUtcIso(to),
    };
}
