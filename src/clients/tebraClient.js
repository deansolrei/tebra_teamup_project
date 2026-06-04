import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { config } from '../config.js';
import { buildSoapEnvelope, xmlTag, TEBRA_NAMESPACE } from '../utils/xml.js';


const http = axios.create({
  timeout: 30000,
  headers: {
    'Content-Type': 'text/xml; charset=utf-8',
  },
});


// ---- shared helpers -------------------------------------------------------


function redactSecrets(xml) {
  return xml
    .replace(/(<CustomerKey>)(.*?)(<\/CustomerKey>)/g, '$1[REDACTED]$3')
    .replace(/(<Password>)(.*?)(<\/Password>)/g, '$1[REDACTED]$3')
    .replace(/(<User>)(.*?)(<\/User>)/g, '$1[REDACTED]$3');
}


function requestHeaderXml() {
  // DataContract order: ClientVersion, CustomerKey, Password, User.
  return `
   <RequestHeader>
     ${xmlTag('ClientVersion', config.tebra.clientVersion ?? '2.1')}
     ${xmlTag('CustomerKey', config.tebra.customerKey)}
     ${xmlTag('Password', config.tebra.password)}
     ${xmlTag('User', config.tebra.username)}
   </RequestHeader>
 `;
}


function optionalXmlTag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return xmlTag(name, value);
}


function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}


// Returns null for <Element i:nil="true"/>, otherwise the text value.
// Exported because callers (and tests) need to handle nil fields like
// ErrorMessage / StackTrace, which xml2js renders as { '$': { 'i:nil': 'true' } }.
export function unwrapNil(node) {
  if (node === undefined || node === null) return null;
  if (node?.$?.['i:nil'] === 'true') return null;
  return node?._ ?? node;
}


// SOAP prefix isn't guaranteed (s:, soap:, etc.), so find Envelope/Body by
// suffix rather than assuming a fixed prefix.
function findByLocalName(obj, localName) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of Object.keys(obj)) {
    const local = key.includes(':') ? key.split(':').pop() : key;
    if (local === localName) return obj[key];
  }
  return undefined;
}


// Throws if the parsed response carries a SOAP Fault. This guards EVERY
// operation — a malformed body (e.g. the DeserializationFailed we hit on the
// missing <Appointment> wrapper) now throws loudly instead of returning a
// fault envelope that downstream code misreads as success.
function throwIfSoapFault(operation, parsed) {
  const envelope = findByLocalName(parsed, 'Envelope');
  const bodyNode = findByLocalName(envelope, 'Body');
  const fault = findByLocalName(bodyNode, 'Fault');
  if (!fault) return;

  const rawCode =
    fault.faultcode?._ ?? fault.faultcode ?? '(no faultcode)';
  const rawString =
    fault.faultstring?._ ?? fault.faultstring ?? '(no faultstring)';

  const err = new Error(`${operation} SOAP Fault: ${rawString}`);
  err.soapFault = { faultcode: rawCode, faultstring: rawString, detail: fault.detail };
  throw err;
}


async function soapRequest(operation, innerXml, { log = false } = {}) {
  const xml = buildSoapEnvelope(operation, innerXml);


  if (log) {
    console.log(`${operation} SOAP request:\n`, redactSecrets(xml));
  }


  try {
    const response = await http.post(config.tebra.soapUrl, xml, {
      headers: {
        SOAPAction: `${TEBRA_NAMESPACE}KareoServices/${operation}`,
      },
    });


    const parsed = await parseStringPromise(response.data, { explicitArray: false });

    // Centralized fault guard: applies to every operation.
    throwIfSoapFault(operation, parsed);

    return parsed;
  } catch (error) {
    if (error.soapFault) {
      // Already a parsed SOAP fault — log its message, not the HTTP layer.
      console.error(`${operation} SOAP fault:`, error.soapFault.faultstring);
    } else if (error.response) {
      console.error(`${operation} SOAP status:`, error.response.status);
      console.error(`${operation} SOAP response:`, error.response.data);
    } else {
      console.error(`${operation} SOAP error:`, error.message);
    }
    throw error;
  }
}


function patientSummaryXml(patientSummary) {
  if (!patientSummary) return '';


  if (typeof patientSummary === 'string') {
    return `
     <PatientSummary>
       ${xmlTag('FirstName', patientSummary)}
     </PatientSummary>
   `;
  }


  const ps = patientSummary;
  return `
   <PatientSummary>
     ${optionalXmlTag('DateOfBirth', ps.dateOfBirth)}
     ${optionalXmlTag('Email', ps.email)}
     ${optionalXmlTag('FirstName', ps.firstName)}
     ${optionalXmlTag('HomePhone', ps.homePhone)}
     ${optionalXmlTag('LastName', ps.lastName)}
     ${optionalXmlTag('MiddleName', ps.middleName)}
     ${optionalXmlTag('MobilePhone', ps.mobilePhone)}
     ${optionalXmlTag('PatientId', ps.patientId)}
     ${optionalXmlTag('WorkPhone', ps.workPhone)}
   </PatientSummary>
 `;
}


// Only emit ResourceIds when there is at least one real resource.
// The real record (appt 14373) shows ResourceId=0 and an EMPTY ResourceIds
// for a working appointment — sending phantom resource 4 was part of the
// translation failure.
function resourceIdsXml(resourceIds) {
  const ids = ensureArray(resourceIds).filter(
    (id) => id !== undefined && id !== null && `${id}` !== '' && `${id}` !== '0'
  );
  if (ids.length === 0) return '';


  const items = ids.map((id) => `<a:int>${id}</a:int>`).join('');
  return `<ResourceIds xmlns:a="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${items}</ResourceIds>`;
}


// ---- operations -----------------------------------------------------------


export async function getProviders() {
  const body = `
   <request>
     ${requestHeaderXml()}
     <Fields>
       ${xmlTag('Active', true)}
       ${xmlTag('EmailAddress', true)}
       ${xmlTag('FirstName', true)}
       ${xmlTag('FullName', true)}
       ${xmlTag('ID', true)}
       ${xmlTag('LastName', true)}
       ${xmlTag('Type', true)}
     </Fields>
     <Filter>
       ${xmlTag('PracticeName', config.tebra.practiceName)}
     </Filter>
   </request>
 `;


  return soapRequest('GetProviders', body, { log: true });
}


// WRITE. Payload-driven, field order matches the real Appointment contract
// confirmed by GetAppointment (appt 14373). AppointmentMode added — it was
// missing entirely from prior attempts and is present on every real record.
export async function createAppointment(payload) {
  const p = payload ?? {};


  const body = `
   <request>
     ${requestHeaderXml()}
     <Appointment>
       ${optionalXmlTag('AppointmentMode', p.appointmentMode)}
       ${optionalXmlTag('AppointmentName', p.appointmentName)}
       ${optionalXmlTag('AppointmentReasonId', p.appointmentReasonId)}
       ${optionalXmlTag('AppointmentStatus', p.appointmentStatus)}
       ${optionalXmlTag('AppointmentType', p.appointmentType)}
       ${optionalXmlTag('EndTime', p.endTime)}
       ${optionalXmlTag('IsRecurring', p.isRecurring)}
       ${optionalXmlTag('MaxAttendees', p.maxAttendees)}
       ${optionalXmlTag('Notes', p.notes)}
       ${patientSummaryXml(p.patientSummary)}
       ${optionalXmlTag('PracticeId', p.practiceId)}
       ${optionalXmlTag('ProviderId', p.providerId)}
       ${optionalXmlTag('ResourceId', p.resourceId ?? 0)}
       ${resourceIdsXml(p.resourceIds)}
       ${optionalXmlTag('ServiceLocationId', p.serviceLocationId)}
       ${optionalXmlTag('StartTime', p.startTime)}
       ${optionalXmlTag('WasCreatedOnline', p.wasCreatedOnline ?? false)}
     </Appointment>
   </request>
 `;


  return soapRequest('CreateAppointment', body, { log: true });
}


// WRITE. NOTE: UpdateAppointment uses a DIFFERENT contract than Create/Get.
// It does NOT accept the <PatientSummary> wrapper — it wants a FLAT <PatientId>
// (plus optional OccurrenceId / PatientCaseId) slotted alphabetically between
// Notes and PracticeId. WCF enforces strict alphabetical element order, so the
// order below is load-bearing — do not reorder.
export async function updateAppointment(payload) {
  const p = payload ?? {};


  const body = `
   <request>
     ${requestHeaderXml()}
     <Appointment>
       ${optionalXmlTag('AppointmentId', p.appointmentId)}
       ${optionalXmlTag('AppointmentMode', p.appointmentMode)}
       ${optionalXmlTag('AppointmentName', p.appointmentName)}
       ${optionalXmlTag('AppointmentReasonId', p.appointmentReasonId)}
       ${optionalXmlTag('AppointmentStatus', p.appointmentStatus)}
       ${optionalXmlTag('AppointmentType', p.appointmentType)}
       ${optionalXmlTag('EndTime', p.endTime)}
       ${optionalXmlTag('IsRecurring', p.isRecurring)}
       ${optionalXmlTag('MaxAttendees', p.maxAttendees)}
       ${optionalXmlTag('Notes', p.notes)}
       ${optionalXmlTag('OccurrenceId', p.occurrenceId)}
       ${optionalXmlTag('PatientCaseId', p.patientCaseId)}
       ${optionalXmlTag('PatientId', p.patientId)}
       ${optionalXmlTag('PracticeId', p.practiceId)}
       ${optionalXmlTag('ProviderId', p.providerId)}
       ${optionalXmlTag('ResourceId', p.resourceId ?? 0)}
       ${resourceIdsXml(p.resourceIds)}
       ${optionalXmlTag('ServiceLocationId', p.serviceLocationId)}
       ${optionalXmlTag('StartTime', p.startTime)}
     </Appointment>
   </request>
 `;


  return soapRequest('UpdateAppointment', body, { log: true });
}


export async function getAppointments(filter = {}) {
  const body = `
   <request>
     ${requestHeaderXml()}
     <Filter>
       ${optionalXmlTag('PracticeName', filter.practiceName)}
       ${optionalXmlTag('ConfirmationStatus', filter.confirmationStatus)}
       ${optionalXmlTag('EndDate', filter.endDate)}
       ${optionalXmlTag('FromCreatedDate', filter.fromCreatedDate)}
       ${optionalXmlTag('FromLastModifiedDate', filter.fromLastModifiedDate)}
       ${optionalXmlTag('PatientId', filter.patientId)}
       ${optionalXmlTag('ServiceLocationName', filter.serviceLocationName)}
       ${optionalXmlTag('StartDate', filter.startDate)}
       ${optionalXmlTag('TimeZoneOffsetFromGMT', filter.timeZoneOffsetFromGMT)}
       ${optionalXmlTag('ToCreatedDate', filter.toCreatedDate)}
       ${optionalXmlTag('ToLastModifiedDate', filter.toLastModifiedDate)}
       ${optionalXmlTag('Type', filter.type)}
     </Filter>
   </request>
 `;


  return soapRequest('GetAppointments', body, { log: true });
}


// Single-record fetch — this is the call that gave us ground truth.
export async function getAppointment(appointmentId) {
  const body = `
   <request>
     ${requestHeaderXml()}
     <Appointment>
       ${xmlTag('AppointmentId', appointmentId)}
     </Appointment>
   </request>
 `;


  return soapRequest('GetAppointment', body, { log: true });
}


export async function deleteAppointment(appointmentId) {
  const body = `
   <request>
     ${requestHeaderXml()}
     <Appointment>
       ${xmlTag('AppointmentId', appointmentId)}
     </Appointment>
   </request>
 `;


  return soapRequest('DeleteAppointment', body, { log: true });
}