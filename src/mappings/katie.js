import { config } from '../config.js';
import { toUtcIso } from '../utils/time.js';

// Katherine Robins' blocked-time appointments are represented in Tebra by a
// dedicated placeholder patient (PatientID 905).
const KR_H2_KATIES_APPT1_PATIENT_NAME = "KR H2 Katie's Appt1";
const KR_H2_KATIES_APPT1_PATIENT_ID = 905;

const KATIE_MAPPING = {
    // ---- identifiers / metadata used by the client to look things up ----
    providerName: 'Katherine Robins',
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
    patientId: KR_H2_KATIES_APPT1_PATIENT_ID,
    providerId: 2,
    resourceId: 4,
    resourceIds: [4],
    wasCreatedOnline: false,
};

export function buildKatieCreatePayload(teamupEvent) {
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    // PRIVACY: AppointmentName is ALWAYS the placeholder patient name — never the Teamup event title.
    const appointmentName = `${marker} | ${KR_H2_KATIES_APPT1_PATIENT_NAME}`.slice(0, 100);
    const patientSummary = {
        patientId: KR_H2_KATIES_APPT1_PATIENT_ID,
        firstName: 'KR',
        lastName: "H2 Katie's Appt1",
    };

    return {
        ...KATIE_MAPPING,
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

export function buildKatieUpdatePayload(teamupEvent, tebraAppointmentId) {
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    return {
        appointmentId: tebraAppointmentId,
        appointmentMode: KATIE_MAPPING.appointmentMode,
        appointmentName: `${marker} | ${KR_H2_KATIES_APPT1_PATIENT_NAME}`.slice(0, 100),
        appointmentReasonId: KATIE_MAPPING.appointmentReasonId,
        appointmentStatus: KATIE_MAPPING.appointmentStatus,
        appointmentType: KATIE_MAPPING.appointmentType,
        endTime: endsAtUtc,
        isRecurring: KATIE_MAPPING.isRecurring,
        notes: [
            marker,
            `TeamupEventID=${teamupId}`,
            `SourceStartUTC=${startsAtUtc}`,
            `SourceEndUTC=${endsAtUtc}`,
        ].join(' | '),
        patientId: KR_H2_KATIES_APPT1_PATIENT_ID,
        practiceId: KATIE_MAPPING.practiceId,
        providerId: KATIE_MAPPING.providerId,
        resourceId: 0,
        serviceLocationId: KATIE_MAPPING.serviceLocationId,
        startTime: startsAtUtc,
    };
}

export function buildKatieVerificationFilter(teamupEvent) {
    const start = new Date(teamupEvent.startsAt);
    const end = new Date(teamupEvent.endsAt);

    const from = new Date(start.getTime() - 60 * 60 * 1000);
    const to = new Date(end.getTime() + 60 * 60 * 1000);

    return {
        practiceName: config.tebra.practiceName,
        serviceLocationName: config.tebra.serviceLocationName,
        patientId: KR_H2_KATIES_APPT1_PATIENT_ID,
        startDate: toUtcIso(from),
        endDate: toUtcIso(to),
    };
}