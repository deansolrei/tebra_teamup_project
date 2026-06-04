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
//
// CAUTION: `appointmentMode` is the one field whose enum type lives in a DIFFERENT
// namespace (http://schemas.datacontract.org/2004/07/AppointmentService.Model).
// tebraClient.js must qualify that element accordingly. Valid values: InOffice, Telehealth.

// Jodene Jensen's blocked-time appointments are represented in Tebra by a
// dedicated placeholder patient: "JJ Block" (PatientID 901).
const JODENE_BLOCK_PATIENT_NAME = 'JJ Block';
const JODENE_BLOCK_PATIENT_ID = 901;

const JODENE_MAPPING = {
    // ---- identifiers / metadata used by the client to look things up ----
    providerName: 'Jodene Jensen',
    practiceId: Number(config.tebra.practiceId),
    practiceName: config.tebra.practiceName,
    serviceLocationId: Number(config.tebra.serviceLocationId), // ensure .env = 22
    serviceLocationName: config.tebra.serviceLocationName,

    // ---- AppointmentCreate fields ----
    appointmentReasonId: 107,   // 111 is NOT a valid reason id
    appointmentStatus: 'Scheduled', // enum: Scheduled, Confirmed, CheckedIn, ...
    appointmentType: 'P',           // enum: U | P | O
    appointmentMode: 'Telehealth',  // enum (other namespace): InOffice | Telehealth
    isRecurring: false,
    patientId: JODENE_BLOCK_PATIENT_ID, // JJ Block (901)
    providerId: 1,
    resourceId: 4,              // Test Facility is 4
    resourceIds: [4],           // match resourceId
    wasCreatedOnline: false,
    // recurrenceRule intentionally omitted here; it is a complex type, not a
    // string. Only set it (as an object) when isRecurring is true.
};

export function buildJodeneCreatePayload(teamupEvent) {
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    // PRIVACY: AppointmentName is ALWAYS "JJ Block" — never the Teamup event title.
    // The source calendar contains real client names; none of that leaks into Tebra.
    const appointmentName = `${marker} | ${JODENE_BLOCK_PATIENT_NAME}`.slice(0, 100);
    const patientSummary = {
        patientId: JODENE_BLOCK_PATIENT_ID,
        firstName: 'JJ',
        lastName: 'Block',
    };

    return {
        ...JODENE_MAPPING,
        appointmentName,
        startTime: startsAtUtc,
        endTime: endsAtUtc,
        patientSummary,
        recurrenceRule: null,
        // PRIVACY: Notes contain only the Teamup event ID for recovery tracing.
        // No titles, client names, or other Teamup event content.
        notes: [
            marker,
            `TeamupEventID=${teamupId}`,
            `SourceStartUTC=${startsAtUtc}`,
            `SourceEndUTC=${endsAtUtc}`,
        ].join(' | '),
    };
}

/**
 * Build the UpdateAppointment payload.
 * UpdateAppointment uses a different contract than Create — it wants a flat
 * PatientId (not PatientSummary) and requires AppointmentId.
 */
export function buildJodeneUpdatePayload(teamupEvent, tebraAppointmentId) {
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    // PRIVACY: Same rule as Create — always "JJ Block", never the Teamup event title.
    return {
        appointmentId: tebraAppointmentId,
        appointmentMode: JODENE_MAPPING.appointmentMode,
        appointmentName: `${marker} | ${JODENE_BLOCK_PATIENT_NAME}`.slice(0, 100),
        appointmentReasonId: JODENE_MAPPING.appointmentReasonId,
        appointmentStatus: JODENE_MAPPING.appointmentStatus,
        appointmentType: JODENE_MAPPING.appointmentType,
        endTime: endsAtUtc,
        isRecurring: JODENE_MAPPING.isRecurring,
        notes: [
            marker,
            `TeamupEventID=${teamupId}`,
            `SourceStartUTC=${startsAtUtc}`,
            `SourceEndUTC=${endsAtUtc}`,
        ].join(' | '),
        patientId: JODENE_BLOCK_PATIENT_ID,
        practiceId: JODENE_MAPPING.practiceId,
        providerId: JODENE_MAPPING.providerId,
        resourceId: 0,
        serviceLocationId: JODENE_MAPPING.serviceLocationId,
        startTime: startsAtUtc,
    };
}

export function buildJodeneVerificationFilter(teamupEvent) {
    const start = new Date(teamupEvent.startsAt);
    const end = new Date(teamupEvent.endsAt);

    const from = new Date(start.getTime() - 60 * 60 * 1000);
    const to = new Date(end.getTime() + 60 * 60 * 1000);

    // AppointmentFilter fields per WSDL: StartDate, EndDate, PatientID,
    // PracticeName, ServiceLocationName, etc. All filter values are xs:string.
    return {
        practiceName: config.tebra.practiceName,
        serviceLocationName: config.tebra.serviceLocationName,
        patientId: JODENE_BLOCK_PATIENT_ID, // JJ Block (901)
        startDate: toUtcIso(from),
        endDate: toUtcIso(to),
    };
}