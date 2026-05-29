import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { config } from '../config.js';
import { buildSoapEnvelope, xmlTag } from '../utils/xml.js';

const http = axios.create({
  timeout: 30000,
  headers: {
    'Content-Type': 'text/xml; charset=utf-8',
  },
});

function authXml() {
  return `
    ${xmlTag('CustomerKey', config.tebra.customerKey)}
    ${xmlTag('Password', config.tebra.password)}
    ${xmlTag('User', config.tebra.username)}
  `;
}

function optionalXmlTag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return xmlTag(name, value);
}

async function soapRequest(action, innerXml) {
  const xml = buildSoapEnvelope(action, innerXml);

  if (action === 'CreateAppointment') {
    console.log('CreateAppointment SOAP request:\n', xml);
  }

  try {
    const response = await http.post(config.tebra.soapUrl, xml, {
      headers: {
        SOAPAction: `http://tempuri.org/${action}`,
      },
    });

    return parseStringPromise(response.data, { explicitArray: false });
  } catch (error) {
    if (error.response) {
      console.error('Tebra SOAP status:', error.response.status);
      console.error('Tebra SOAP response:', error.response.data);
    } else {
      console.error('Tebra SOAP error:', error.message);
    }
    throw error;
  }
}

function patientSummaryXml(patientSummary) {
  if (typeof patientSummary === 'string') {
    return `
      <PatientSummary>
        ${xmlTag('FirstName', patientSummary)}
      </PatientSummary>
    `;
  }

  const ps = patientSummary || {};
  return `
    <PatientSummary>
      ${optionalXmlTag('DateOfBirth', ps.dateOfBirth)}
      ${optionalXmlTag('Email', ps.email)}
      ${optionalXmlTag('FirstName', ps.firstName)}
      ${optionalXmlTag('HomePhone', ps.homePhone)}
      ${optionalXmlTag('LastName', ps.lastName)}
      ${optionalXmlTag('MiddleName', ps.middleName)}
      ${optionalXmlTag('MobilePhone', ps.mobilePhone)}
      ${optionalXmlTag('PatientID', ps.patientId)}
      ${optionalXmlTag('WorkPhone', ps.workPhone)}
    </PatientSummary>
  `;
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function createAppointment(payload) {
  const body = `
    ${authXml()}
    ${xmlTag('AppointmentMode', payload.appointmentMode || '')}
    ${xmlTag('AppointmentName', payload.appointmentName || '')}
    ${xmlTag('AppointmentReasonID', payload.appointmentReasonId)}
    ${xmlTag('AppointmentStatus', payload.appointmentStatus)}
    ${xmlTag('AppointmentType', payload.appointmentType)}
    ${xmlTag('EndTime', payload.endTime)}
    ${xmlTag('IsRecurring', payload.isRecurring)}
    ${xmlTag('MaxAttendees', payload.maxAttendees ?? 1)}
    ${xmlTag('Notes', payload.notes || '')}
    ${xmlTag('PatientID', payload.patientId)}
    ${patientSummaryXml(payload.patientSummary)}
    ${xmlTag('PracticeID', payload.practiceId)}
    ${xmlTag('ProviderID', payload.providerId)}
    ${xmlTag('RecurrenceRule', payload.recurrenceRule ?? '')}
    ${xmlTag('ResourceID', payload.resourceId)}
    <ResourceIDs>
      ${ensureArray(payload.resourceIds).map((id) => xmlTag('long', id)).join('')}
    </ResourceIDs>
    ${xmlTag('ServiceLocationID', payload.serviceLocationId)}
    ${xmlTag('StartTime', payload.startTime)}
    ${xmlTag('WasCreatedOnline', payload.wasCreatedOnline)}
  `;

  return soapRequest('CreateAppointment', body);
}

export async function getAppointments(filter) {
  const body = `
    ${authXml()}
    ${xmlTag('PracticeName', filter.practiceName)}
    ${filter.confirmationStatus ? xmlTag('ConfirmationStatus', filter.confirmationStatus) : ''}
    ${filter.endDate ? xmlTag('EndDate', filter.endDate) : ''}
    ${filter.fromCreatedDate ? xmlTag('FromCreatedDate', filter.fromCreatedDate) : ''}
    ${filter.fromLastModifiedDate ? xmlTag('FromLastModifiedDate', filter.fromLastModifiedDate) : ''}
    ${filter.patientId ? xmlTag('PatientID', filter.patientId) : ''}
    ${filter.serviceLocationName ? xmlTag('ServiceLocationName', filter.serviceLocationName) : ''}
    ${filter.startDate ? xmlTag('StartDate', filter.startDate) : ''}
    ${filter.timeZoneOffsetFromGMT ? xmlTag('TimeZoneOffsetFromGMT', filter.timeZoneOffsetFromGMT) : ''}
    ${filter.toCreatedDate ? xmlTag('ToCreatedDate', filter.toCreatedDate) : ''}
    ${filter.toLastModifiedDate ? xmlTag('ToLastModifiedDate', filter.toLastModifiedDate) : ''}
    ${filter.type ? xmlTag('Type', filter.type) : ''}
  `;

  return soapRequest('GetAppointments', body);
}

export async function deleteAppointment(appointmentId) {
  const body = `
    ${authXml()}
    ${xmlTag('AppointmentID', appointmentId)}
  `;

  return soapRequest('DeleteAppointment', body);
}
