// test-delete.js
import { deleteAppointment, getAppointment } from './src/clients/tebraClient.js';

const TEST_APPT_ID = 14371; // confirmed deleted last run

function extractAppt(raw, op) {
    return raw?.['s:Envelope']?.['s:Body']
        ?.[`${op}Response`]?.[`${op}Result`]?.Appointment;
}

// Returns null for <Element i:nil="true"/>, otherwise the text value.
function unwrapNil(node) {
    if (node?.$?.['i:nil'] === 'true') return null;
    return node?._ ?? node;
}

async function testDelete() {
    // Confirm what we're about to delete actually exists first.
    const beforeRaw = await getAppointment(TEST_APPT_ID);
    const before = extractAppt(beforeRaw, 'GetAppointment');
    console.log('Before delete:', before
        ? `present — Start: ${before.StartTime}`
        : 'NOT FOUND (aborting before delete)');
    if (!before) return;

    const result = await deleteAppointment(TEST_APPT_ID);
    console.log('RAW DELETE RESPONSE:\n', JSON.stringify(result, null, 2));

    // Guard against SOAP faults (malformed request, etc.)
    const fault = result?.['s:Envelope']?.['s:Body']?.['s:Fault'];
    if (fault) {
        const msg = fault.faultstring?._ ?? fault.faultstring;
        throw new Error(`SOAP Fault: ${msg}`);
    }

    const resp = result?.['s:Envelope']?.['s:Body']
        ?.DeleteAppointmentResponse?.DeleteAppointmentResult;

    console.log('IsError:     ', resp?.ErrorResponse?.IsError);
    console.log('ErrorMessage:', unwrapNil(resp?.ErrorResponse?.ErrorMessage));

    // The real success signal is Deleted=true, not IsError.
    const deleted = String(resp?.Deleted).toLowerCase() === 'true';
    console.log('Deleted:     ', resp?.Deleted);
    if (!deleted) throw new Error('DeleteAppointment did not confirm Deleted=true');

    // Re-fetch to see what GetAppointment returns for a deleted ID.
    const afterRaw = await getAppointment(TEST_APPT_ID);
    console.log('RAW AFTER:\n', JSON.stringify(afterRaw, null, 2));
}

testDelete().catch(console.error);