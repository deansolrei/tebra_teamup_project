import { createAppointment, deleteAppointment } from '../clients/tebraClient.js';

// Helper: build an ISO-ish local datetime string for "tomorrow at HH:MM".
// Kareo generally expects local practice time without a trailing 'Z'.
function tomorrowAt(hour, minute = 0) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(hour, minute, 0, 0);
    // Format: YYYY-MM-DDTHH:MM:SS  (no timezone suffix)
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

async function main() {
    const start = tomorrowAt(10, 0); // tomorrow 10:00
    const end = tomorrowAt(10, 30);  // tomorrow 10:30

    // Declare the payload ONCE, then reuse it. This was the missing piece:
    // the inline object was never bound to a variable, so the later
    // `payload` reference threw "payload is not defined".
    const payload = {
        appointmentMode: 'Telehealth',
        appointmentStatus: 'Scheduled',
        appointmentType: 'P',
        appointmentReasonId: 96,
        providerId: 3,
        serviceLocationId: 1,
        resourceId: 4,          // <-- changed from 0
        resourceIds: [4],       // <-- newly added, was missing
        practiceId: 1,
        patientSummary: { patientId: 582 },
        maxAttendees: 200,
        isRecurring: false,
        startTime: '2026-05-31T21:00:00Z',
        endTime: '2026-05-31T21:25:00Z',
        notes: 'Automated integration test appointment. Safe to delete.',
    };

    console.log('Creating test appointment with payload:\n', payload);

    const result = await createAppointment(payload);
    console.log('\n===== CREATE RESPONSE =====\n');
    console.log(JSON.stringify(result, null, 2));

    return result;
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Test run failed:', err.message);
        process.exit(1);
    });