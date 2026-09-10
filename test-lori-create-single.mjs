import { createAppointment } from './src/clients/tebraClient.js';
import { buildLoriCreatePayload } from './src/mappings/lori.js';

function tomorrowAt(hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const fakeEvent = {
  teamupEventId: 'MANUAL-AUTH-TEST',
  startsAt: tomorrowAt(10, 0),
  endsAt: tomorrowAt(10, 30),
};

const payload = buildLoriCreatePayload(fakeEvent);
console.log('Attempting single test create for Lori...');
const result = await createAppointment(payload);
console.log('RAW RESULT:');
console.dir(result, { depth: 8 });
