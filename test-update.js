// test-update.js  — run with: node test-update.js
import { getAppointment, updateAppointment } from './src/clients/tebraClient.js';

const TEST_APPT_ID = 14563;

// Unwrap xml2js values: <Foo i:nil="true"/> parses to { '$': { 'i:nil': 'true' } }.
function val(field, fallback = '') {
    if (field === undefined || field === null) return fallback;
    if (typeof field === 'object') {
        if (field.$ && field.$['i:nil'] === 'true') return fallback;
        if ('_' in field) return field._;
        return fallback;
    }
    return field;
}

// Dig the Appointment object out of the parsed SOAP envelope, tolerating
// whatever namespace prefixes xml2js kept.
function extractAppointment(parsed, responseKey, resultKey) {
    const env = parsed['s:Envelope'] ?? parsed.Envelope;
    const body = env?.['s:Body'] ?? env?.Body;
    const result = body?.[responseKey]?.[resultKey];

    // Surface server-side business errors (IsError=true with no SOAP Fault).
    const err = result?.ErrorResponse;
    if (err && String(err.IsError).toLowerCase() === 'true') {
        const msg = val(err.ErrorMessage, 'Unknown API error');
        throw new Error(`Tebra ${responseKey} error: ${msg}`);
    }

    return result; // still the wrapper — call sites keep using .Appointment
}

async function main() {
    // 1) Fetch current ground truth.
    const beforeParsed = await getAppointment(TEST_APPT_ID);
    const before = extractAppointment(
        beforeParsed, 'GetAppointmentResponse', 'GetAppointmentResult'
    );

    if (!before || !before.Appointment) {
        console.log('\n--- RAW getAppointment (could not locate Appointment) ---\n');
        console.log(JSON.stringify(beforeParsed, null, 2));
        throw new Error('Could not find Appointment in response — check the path above.');
    }

    const appt = before.Appointment;
    console.log('BEFORE — Name:', val(appt.AppointmentName, '(null)'),
        '| Notes:', val(appt.Notes, '(null)'));

    // 2) Build update from current values + the two fields we are changing.
    const payload = {
        appointmentId: TEST_APPT_ID,
        appointmentName: 'Block - update verification',          // REQUIRED, was null
        notes: `UPDATED ${new Date().toISOString()} - verification test`,
        appointmentStatus: val(appt.AppointmentStatus, 'Scheduled'),
        appointmentReasonId: val(appt.AppointmentReasonId),
        serviceLocationId: val(appt.ServiceLocationId),
        providerId: val(appt.ProviderId),
        startTime: val(appt.StartTime),
        endTime: val(appt.EndTime),
        maxAttendees: val(appt.MaxAttendees, 200),
        appointmentMode: val(appt.AppointmentMode, 'Telehealth'),
        appointmentType: val(appt.AppointmentType, 'P'),
        practiceId: val(appt.PracticeId, 1),
        isRecurring: false,
        // FLAT patient id — Update contract does NOT use PatientSummary.
        patientId: val(appt.PatientSummary?.PatientId),
    };

    // 3) Send update.
    const updParsed = await updateAppointment(payload);

    // TEMP: always dump the raw parsed update response so we can see the truth.
    if (process.env.DEBUG) {
        console.log('\n--- RAW UpdateAppointment response ---\n');
        console.log(JSON.stringify(updParsed, null, 2));
    }

    const updResult = extractAppointment(
        updParsed, 'UpdateAppointmentResponse', 'UpdateAppointmentResult'
    );
    console.log('\n--- UpdateAppointment result (extracted) ---');
    console.log(JSON.stringify(updResult, null, 2));

    // 4) Re-fetch and confirm BOTH fields persisted.
    const afterParsed = await getAppointment(TEST_APPT_ID);
    const after = extractAppointment(
        afterParsed, 'GetAppointmentResponse', 'GetAppointmentResult'
    )?.Appointment;
    console.log('\nAFTER  — Name:', val(after?.AppointmentName, '(null)'),
        '| Notes:', val(after?.Notes, '(null)'));
}

main().catch((err) => {
    console.log('\n===== UPDATE TEST FAILED =====\n');
    console.log(err.message);
    if (err.response?.data) console.log(err.response.data);
});