import { config } from '../config.js';
import { buildJodeneCreatePayload, buildJodeneVerificationFilter } from '../mappings/jodene.js';
import { createAppointment, getAppointments, deleteAppointment } from '../clients/tebraClient.js';
import { sleep } from '../utils/time.js';

export async function createVerifyDeleteFromTeamupEvent(teamupEvent) {
  const createPayload = buildJodeneCreatePayload(teamupEvent);
  const verificationFilter = buildJodeneVerificationFilter(teamupEvent);

  if (config.sync.dryRun) {
    return {
      mode: 'dry-run',
      createPayload,
      verificationFilter,
    };
  }

  const createResponse = await createAppointment(createPayload);
  const createdAppointmentId = extractCreatedAppointmentId(createResponse);

  const verifyResponse = await verifyAppointmentWithRetry({
    teamupEvent,
    createPayload,
    verificationFilter,
    createdAppointmentId,
  });

  const matchedAppointment = findVerifiedAppointment(
    verifyResponse,
    createPayload,
    verificationFilter,
    createdAppointmentId
  );

  const result = {
    mode: 'live',
    createPayload,
    createResponse,
    createdAppointmentId: createdAppointmentId || null,
    verificationFilter,
    verifyResponse,
    verified: Boolean(matchedAppointment),
    verifiedAppointment: matchedAppointment || null,
  };

  if (config.sync.autoDeleteAfterVerify) {
    const appointmentIdToDelete =
      (matchedAppointment && extractAppointmentIdFromRecord(matchedAppointment)) ||
      createdAppointmentId ||
      null;

    if (appointmentIdToDelete) {
      result.deleteResponse = await deleteAppointment(appointmentIdToDelete);
      result.deletedAppointmentId = appointmentIdToDelete;
    } else {
      result.deleteSkipped = true;
      result.deleteSkipReason =
        'Could not extract AppointmentID from verified record or create response';
    }
  }

  return result;
}

async function verifyAppointmentWithRetry({
  teamupEvent,
  createPayload,
  verificationFilter,
  createdAppointmentId,
}) {
  const attempts = Number(config.sync.verifyAttempts ?? 5);
  const delayMs = Number(config.sync.verifyDelayMs ?? 1500);

  let lastResponse = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(delayMs);
    } else {
      await sleep(delayMs);
    }

    const response = await getAppointments(verificationFilter);
    lastResponse = response;

    const matched = findVerifiedAppointment(
      response,
      createPayload,
      verificationFilter,
      createdAppointmentId
    );

    if (matched) {
      return response;
    }
  }

  return lastResponse;
}

function findVerifiedAppointment(response, createPayload, verificationFilter, createdAppointmentId) {
  const appointments = normalizeAppointments(response);
  if (!appointments.length) return null;

  if (createdAppointmentId) {
    const byId = appointments.find((appt) => {
      const apptId = extractAppointmentIdFromRecord(appt);
      return apptId && String(apptId) === String(createdAppointmentId);
    });
    if (byId) return byId;
  }

  const payloadStart = normalizeDateLike(
    createPayload.StartTime ||
    createPayload.startTime ||
    createPayload.start ||
    verificationFilter.StartDate ||
    verificationFilter.startDate
  );

  const payloadEnd = normalizeDateLike(
    createPayload.EndTime ||
    createPayload.endTime ||
    createPayload.end ||
    verificationFilter.EndDate ||
    verificationFilter.endDate
  );

  const payloadPatientSummary = normalizeText(
    createPayload.PatientSummary || createPayload.patientSummary
  );

  const payloadAppointmentName = normalizeText(
    createPayload.AppointmentName || createPayload.appointmentName
  );

  const payloadProviderId = normalizeText(
    createPayload.ProviderID || createPayload.ProviderId || createPayload.providerId
  );

  const payloadServiceLocationId = normalizeText(
    createPayload.ServiceLocationID ||
    createPayload.ServiceLocationId ||
    createPayload.serviceLocationId
  );

  return (
    appointments.find((appt) => {
      const apptStart = normalizeDateLike(
        appt.StartTime || appt.startTime || appt.StartDate || appt.startDate
      );
      const apptEnd = normalizeDateLike(
        appt.EndTime || appt.endTime || appt.EndDate || appt.endDate
      );

      const apptPatientSummary = normalizeText(
        appt.PatientSummary || appt.patientSummary
      );

      const apptAppointmentName = normalizeText(
        appt.AppointmentName || appt.appointmentName
      );

      const apptProviderId = normalizeText(
        appt.ProviderID || appt.ProviderId || appt.providerId
      );

      const apptServiceLocationId = normalizeText(
        appt.ServiceLocationID || appt.ServiceLocationId || appt.serviceLocationId
      );

      const startMatches = payloadStart && apptStart && payloadStart === apptStart;
      const endMatches = !payloadEnd || !apptEnd || payloadEnd === apptEnd;

      const summaryMatches =
        payloadPatientSummary &&
        apptPatientSummary &&
        payloadPatientSummary === apptPatientSummary;

      const nameMatches =
        payloadAppointmentName &&
        apptAppointmentName &&
        payloadAppointmentName === apptAppointmentName;

      const providerMatches =
        !payloadProviderId || !apptProviderId || payloadProviderId === apptProviderId;

      const serviceLocationMatches =
        !payloadServiceLocationId ||
        !apptServiceLocationId ||
        payloadServiceLocationId === apptServiceLocationId;

      return (
        startMatches &&
        endMatches &&
        providerMatches &&
        serviceLocationMatches &&
        (summaryMatches || nameMatches)
      );
    }) || null
  );
}

function normalizeAppointments(response) {
  if (!response) return [];

  if (Array.isArray(response)) return response;

  if (Array.isArray(response.Appointments)) return response.Appointments;
  if (Array.isArray(response.appointments)) return response.appointments;

  if (response.Appointments && Array.isArray(response.Appointments.Appointment)) {
    return response.Appointments.Appointment;
  }

  if (response.appointments && Array.isArray(response.appointments.appointment)) {
    return response.appointments.appointment;
  }

  if (response.GetAppointmentsResult) {
    return normalizeAppointments(response.GetAppointmentsResult);
  }

  if (response.getAppointmentsResult) {
    return normalizeAppointments(response.getAppointmentsResult);
  }

  if (response.Response) {
    return normalizeAppointments(response.Response);
  }

  if (response.response) {
    return normalizeAppointments(response.response);
  }

  const deepAppointments = deepFindArrayByKey(response, [
    'Appointment',
    'Appointments',
    'appointment',
    'appointments',
  ]);

  return deepAppointments;
}

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

  if (direct && /^\d+$/.test(String(direct))) {
    return String(direct);
  }

  try {
    const serialized = JSON.stringify(response);
    const match = serialized.match(
      /"(?:AppointmentID|AppointmentId|appointmentId|ID|Id|id)":"?(\d+)"?/i
    );
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function extractAppointmentIdFromRecord(record) {
  if (!record || typeof record !== 'object') return null;

  const id =
    record.AppointmentID ??
    record.AppointmentId ??
    record.appointmentId ??
    record.ID ??
    record.Id ??
    record.id ??
    null;

  return id ? String(id) : null;
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

function deepFindArrayByKey(input, keys) {
  if (input == null) return [];

  if (Array.isArray(input)) return input;

  if (typeof input !== 'object') return [];

  for (const key of keys) {
    if (Array.isArray(input[key])) return input[key];
  }

  for (const value of Object.values(input)) {
    const found = deepFindArrayByKey(value, keys);
    if (found.length) return found;
  }

  return [];
}

function normalizeDateLike(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).trim();
  return date.toISOString();
}

function normalizeText(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}
