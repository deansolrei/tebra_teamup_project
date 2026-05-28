import soap from 'soap';
import { config } from './config.js';

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    clientPromise = soap.createClientAsync(config.tebra.soapUrl, {
      endpoint: config.tebra.soapUrl
        .replace(/\?singleWsdl$/i, '')
        .replace(/\?wsdl$/i, ''),
    });
  }

  return clientPromise;
}

function toNumberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function requestHeader() {
  return {
    ClientVersion: '2.1',
    CustomerKey: config.tebra.customerKey || '',
    Password: config.tebra.password || '',
    User: config.tebra.username || '',
  };
}


function compact(value) {
  if (Array.isArray(value)) {
    const arr = value.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .map(([k, v]) => [k, compact(v)])
      .filter(([, v]) => v !== undefined);

    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return value;
}

async function call(operation, args) {
  const client = await getClient();
  const method = client[`${operation}Async`];

  if (typeof method !== 'function') {
    throw new Error(`SOAP operation not found: ${operation}`);
  }

  const payload = compact(args || {});

  try {
    const [result] = await method.call(client, payload);
    return result;
  } catch (error) {
    console.error(`SOAP ${operation} failed`);
    if (error?.root?.Envelope?.Body?.Fault) {
      console.error(JSON.stringify(error.root.Envelope.Body.Fault, null, 2));
    } else {
      console.error(error?.message || error);
    }
    throw error;
  }
}

function buildServiceLocationFields(fields = {}) {
  return {
    AddressLine1: fields.AddressLine1 ?? true,
    AddressLine2: fields.AddressLine2 ?? true,
    BillingName: fields.BillingName ?? true,
    CLIANumber: fields.CLIANumber ?? true,
    City: fields.City ?? true,
    Country: fields.Country ?? true,
    CreatedDate: fields.CreatedDate ?? true,
    FacilityIDType: fields.FacilityIDType ?? true,
    FaxPhone: fields.FaxPhone ?? true,
    FaxPhoneExt: fields.FaxPhoneExt ?? true,
    HCFABox32FacilityID: fields.HCFABox32FacilityID ?? true,
    ID: fields.ID ?? true,
    ModifiedDate: fields.ModifiedDate ?? true,
    NPI: fields.NPI ?? true,
    Name: fields.Name ?? true,
    Phone: fields.Phone ?? true,
    PhoneExt: fields.PhoneExt ?? true,
    PlaceOfService: fields.PlaceOfService ?? true,
    PracticeID: fields.PracticeID ?? true,
    PracticeName: fields.PracticeName ?? true,
    State: fields.State ?? true,
    ZipCode: fields.ZipCode ?? true,
  };
}

function buildServiceLocationFilter({
  fromCreatedDate,
  fromLastModifiedDate,
  id,
  practiceId = config.tebra.practiceId,
  practiceName = config.tebra.practiceName,
  toCreatedDate,
  toLastModifiedDate,
} = {}) {
  return {
    FromCreatedDate: fromCreatedDate,
    FromLastModifiedDate: fromLastModifiedDate,
    ID: id,
    PracticeID: practiceId,
    PracticeName: practiceName,
    ToCreatedDate: toCreatedDate,
    ToLastModifiedDate: toLastModifiedDate,
  };
}

const APPOINTMENT_REASON_MAP = {
  'aaa test service location|25': {
    id: 107,
    guid: '0ce74945-9527-423d-9260-865d362094b9',
  },
  'psychiatry followup assessment|25': {
    id: 108,
    guid: '9b42f405-dc14-4f79-81b1-a484759491cf',
  },
  'psychiatry initial assessment|50': {
    id: 109,
    guid: 'f2292db7-0075-4c1c-aec3-f4096492eb94',
  },
  'psychiatry followup assessment|50': {
    id: 110,
    guid: '0565a5c5-b026-4633-9710-c4a1a7e71de5',
  },
};

function normalizeReasonName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getDurationMinutes(args = {}) {
  const explicit = toNumberOrUndefined(args.durationMinutes);
  if (Number.isFinite(explicit)) return explicit;

  if (args.startTime && args.endTime) {
    const start = new Date(args.startTime);
    const end = new Date(args.endTime);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }

  return undefined;
}

function getAppointmentReasonMatch(args = {}) {
  const durationMinutes = getDurationMinutes(args);
  const reasonName = normalizeReasonName(
    args.reasonName ?? args.appointmentReasonName ?? args.appointmentName
  );

  if (!reasonName || !Number.isFinite(durationMinutes)) {
    return undefined;
  }

  return APPOINTMENT_REASON_MAP[`${reasonName}|${durationMinutes}`];
}

function normalizeAppointmentArgs(args = {}) {
  const durationMinutes = getDurationMinutes(args);
  const reasonMatch = getAppointmentReasonMatch(args);
  const explicitAppointmentReasonId = toNumberOrUndefined(args.appointmentReasonId);

  return {
    appointmentId: toNumberOrUndefined(args.appointmentId),
    appointmentReasonId: explicitAppointmentReasonId ?? reasonMatch?.id,
    appointmentReasonGuid: args.appointmentReasonGuid ?? reasonMatch?.guid,
    appointmentReasonName:
      args.reasonName ?? args.appointmentReasonName ?? args.appointmentName,
    appointmentStatus: args.appointmentStatus,
    appointmentType: args.appointmentType ?? 'P',
    appointmentMode:
      args.appointmentMode ?? config.tebra.defaultAppointmentMode ?? 'Telehealth',
    appointmentName: args.appointmentName,
    attendeesCount: toNumberOrUndefined(args.attendeesCount),
    durationMinutes,
    endTime: args.endTime,
    forRecare: args.forRecare,
    insurancePolicyAuthorizationId: toNumberOrUndefined(args.insurancePolicyAuthorizationId),
    isGroupAppointment: args.isGroupAppointment,
    isRecurring: args.isRecurring ?? false,
    maxAttendees: toNumberOrUndefined(args.maxAttendees),
    notes: args.notes,
    patientCaseId: toNumberOrUndefined(args.patientCaseId),
    patientId: toNumberOrUndefined(args.patientId),
    patientSummary: args.patientSummary,
    patientSummaries: args.patientSummaries,
    practiceId: toNumberOrUndefined(args.practiceId ?? config.tebra.practiceId),
    providerId: toNumberOrUndefined(args.providerId),
    resourceId: toNumberOrUndefined(args.resourceId),
    resourceIds: args.resourceIds,
    serviceLocationId: toNumberOrUndefined(
      args.serviceLocationId ?? config.tebra.serviceLocationId
    ),
    startTime: args.startTime,
    ticketNumber: args.ticketNumber,
    wasCreatedOnline: args.wasCreatedOnline ?? false,
  };
}


export async function getServiceLocations({
  practiceName = config.tebra.practiceName,
  practiceId = config.tebra.practiceId,
  id,
  fromCreatedDate,
  toCreatedDate,
  fromLastModifiedDate,
  toLastModifiedDate,
  fields,
} = {}) {
  return call('GetServiceLocations', {
    request: {
      RequestHeader: requestHeader(),
      Fields: buildServiceLocationFields(fields),
      Filter: buildServiceLocationFilter({
        fromCreatedDate,
        fromLastModifiedDate,
        id,
        practiceId,
        practiceName,
        toCreatedDate,
        toLastModifiedDate,
      }),
    },
  });
}

export async function getAppointments({
  practiceName = config.tebra.practiceName,
  fromCreatedDate,
  toCreatedDate,
  fromLastModifiedDate,
  toLastModifiedDate,
  type,
  confirmationStatus,
  serviceLocationName,
  patientId,
  patientFullName,
  patientCasePayerScenario,
  startIso,
  endIso,
  appointmentReason,
  timeZoneOffsetFromGMT,
  fields,
} = {}) {
  return call('GetAppointments', {
    RequestHeader: requestHeader(),
    PracticeName: practiceName,
    FromCreatedDate: fromCreatedDate,
    ToCreatedDate: toCreatedDate,
    FromLastModifiedDate: fromLastModifiedDate,
    ToLastModifiedDate: toLastModifiedDate,
    Type: type,
    ConfirmationStatus: confirmationStatus,
    ServiceLocationName: serviceLocationName,
    PatientID: patientId,
    PatientFullName: patientFullName,
    PatientCasePayerScenario: patientCasePayerScenario,
    StartDate: startIso,
    EndDate: endIso,
    AppointmentReason: appointmentReason,
    TimeZoneOffsetFromGMT: timeZoneOffsetFromGMT,
    Fields: fields,
  });
}

export async function getAppointment({ appointmentId }) {
  return call('GetAppointment', {
    RequestHeader: requestHeader(),
    AppointmentID: toNumberOrUndefined(appointmentId),
  });
}

export async function getPractices() {
  return call('GetPractices', {
    RequestHeader: requestHeader(),
  });
}

export async function getProviders({
  practiceName = config.tebra.practiceName,
  practiceId = config.tebra.practiceId,
} = {}) {
  return call('GetProviders', {
    RequestHeader: requestHeader(),
    PracticeName: practiceName,
    PracticeID: toNumberOrUndefined(practiceId),
  });
}

export async function getAppointmentReasons({
  practiceName = config.tebra.practiceName,
  practiceId = config.tebra.practiceId,
} = {}) {
  return call('GetAppointmentReasons', {
    RequestHeader: requestHeader(),
    PracticeName: practiceName,
    PracticeID: toNumberOrUndefined(practiceId),
  });
}

export async function createAppointment(args = {}) {
  const a = normalizeAppointmentArgs(args);
  if (!a.appointmentReasonId) {
    throw new Error(
      `Unable to resolve AppointmentReasonID for appointmentName="${a.appointmentReasonName ?? ''}" durationMinutes="${a.durationMinutes ?? ''}"`
    );
  }


  return call('CreateAppointment', {
    RequestHeader: requestHeader(),
    PracticeID: a.practiceId,
    ServiceLocationID: a.serviceLocationId,
    AppointmentStatus: a.appointmentStatus ?? 'Scheduled',
    StartTime: a.startTime,
    EndTime: a.endTime,
    IsRecurring: a.isRecurring,
    PatientSummary: a.patientSummary,
    AppointmentReasonID: a.appointmentReasonId,
    ProviderID: a.providerId,
    ResourceID: a.resourceId,
    Notes: a.notes,
    ResourceIDs: a.resourceIds,
    AppointmentType: a.appointmentType,
    WasCreatedOnline: a.wasCreatedOnline,
    InsurancePolicyAuthorizationID: a.insurancePolicyAuthorizationId,
    PatientCaseID: a.patientCaseId,
    AppointmentName: a.appointmentName,
    IsGroupAppointment: a.isGroupAppointment ?? false,
    MaxAttendees: a.maxAttendees,
    AttendeesCount: a.attendeesCount,
    PatientSummaries: a.patientSummaries,
    ForRecare: a.forRecare,
    PatientID: a.patientId,
    AppointmentMode: a.appointmentMode,
  });
}

export async function updateAppointment(args = {}) {
  const a = normalizeAppointmentArgs(args);
  if (!a.appointmentReasonId) {
    throw new Error(
      `Unable to resolve AppointmentReasonID for appointmentName="${a.appointmentReasonName ?? ''}" durationMinutes="${a.durationMinutes ?? ''}"`
    );
  }


  return call('UpdateAppointment', {
    RequestHeader: requestHeader(),
    AppointmentID: a.appointmentId,
    AppointmentStatus: a.appointmentStatus,
    ServiceLocationID: a.serviceLocationId,
    StartTime: a.startTime,
    EndTime: a.endTime,
    AppointmentReasonID: a.appointmentReasonId,
    ProviderID: a.providerId,
    ResourceID: a.resourceId,
    PatientID: a.patientId,
    ResourceIDs: a.resourceIds,
    Notes: a.notes,
    AppointmentName: a.appointmentName,
    MaxAttendees: a.maxAttendees ?? 1,
    IsGroupAppointment: a.isGroupAppointment,
    InsurancePolicyAuthorizationID: a.insurancePolicyAuthorizationId,
    PatientCaseID: a.patientCaseId,
    AppointmentMode: a.appointmentMode,
    TicketNumber: a.ticketNumber,
  });
}

export async function updateAppointmentStatus(args = {}) {
  const a = normalizeAppointmentArgs(args);
  if (!a.appointmentReasonId) {
    throw new Error(
      `Unable to resolve AppointmentReasonID for appointmentName="${a.appointmentReasonName ?? ''}" durationMinutes="${a.durationMinutes ?? ''}"`
    );
  }


  return call('UpdateAppointmentStatus', {
    RequestHeader: requestHeader(),
    AppointmentID: a.appointmentId,
    AppointmentStatus: a.appointmentStatus,
    ServiceLocationID: a.serviceLocationId,
    StartTime: a.startTime,
    EndTime: a.endTime,
    AppointmentReasonID: a.appointmentReasonId,
    ProviderID: a.providerId,
    ResourceID: a.resourceId,
    PatientID: a.patientId,
    ResourceIDs: a.resourceIds,
    Notes: a.notes,
    AppointmentName: a.appointmentName,
    MaxAttendees: a.maxAttendees ?? 1,
    IsGroupAppointment: a.isGroupAppointment,
    InsurancePolicyAuthorizationID: a.insurancePolicyAuthorizationId,
    PatientCaseID: a.patientCaseId,
    AppointmentMode: a.appointmentMode,
    TicketNumber: a.ticketNumber,
  });
}

export async function cancelAppointment(args = {}) {
  return updateAppointmentStatus({
    ...args,
    appointmentStatus: args.appointmentStatus ?? 'Cancelled',
    appointmentName: args.appointmentName ?? 'Cancelled Appointment',
  });
}
