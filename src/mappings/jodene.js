import { config } from '../config.js';
import { toUtcIso } from '../utils/time.js';

const JODENE_MAPPING = {
    providerName: 'Jodene Jensen',
    practiceId: Number(config.tebra.practiceId),
    practiceName: config.tebra.practiceName,
    serviceLocationId: Number(config.tebra.serviceLocationId),
    serviceLocationName: config.tebra.serviceLocationName,
    providerId: 1,
    resourceId: 1,
    resourceIds: [1],
    patientId: 582,
    patientSummary: 'TEAMUP_TEST_PATIENT_582',
    appointmentReasonId: 111,
    appointmentStatus: 'Scheduled',
    appointmentType: 'P',
    appointmentMode: 'Telehealth',
    wasCreatedOnline: false,
    isRecurring: false,
    recurrenceRule: '',
};

export function buildJodeneCreatePayload(teamupEvent) {
    const safeTitle = (teamupEvent.title || 'Teamup appointment').trim();
    const teamupId = teamupEvent.teamupEventId || teamupEvent.id || 'unknown';
    const startsAtUtc = toUtcIso(teamupEvent.startsAt);
    const endsAtUtc = toUtcIso(teamupEvent.endsAt);
    const marker = String(config.sync.testMarker || 'TEAMUP-TEST').trim();

    const appointmentName = `${marker} | ${safeTitle}`.slice(0, 100);
    const patientSummary = `${marker} PATIENT`.slice(0, 100);

    return {
        ...JODENE_MAPPING,
        startTime: startsAtUtc,
        endTime: endsAtUtc,
        patientSummary,
        recurrenceRule: '',
        appointmentName,
        notes: [
            marker,
            `TeamupEventID=${teamupId}`,
            `TeamupCalendarID=${teamupEvent.calendarId || ''}`,
            `TeamupSubcalendarID=${teamupEvent.subcalendarId || ''}`,
            `SourceTitle=${safeTitle}`,
            `SourceStartUTC=${startsAtUtc}`,
            `SourceEndUTC=${endsAtUtc}`,
        ].join(' | '),
    };
}

export function buildJodeneVerificationFilter(teamupEvent) {
    const start = new Date(teamupEvent.startsAt);
    const end = new Date(teamupEvent.endsAt);

    const from = new Date(start.getTime() - 60 * 60 * 1000);
    const to = new Date(end.getTime() + 60 * 60 * 1000);

    return {
        practiceName: config.tebra.practiceName,
        serviceLocationName: config.tebra.serviceLocationName,
        patientId: 582,
        startDate: toUtcIso(from),
        endDate: toUtcIso(to),
    };
}
