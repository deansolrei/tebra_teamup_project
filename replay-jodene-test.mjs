import { routeEvent } from './src/services/appointmentSyncService.js';

const normalized = {
  teamupEventId: '2135300981',
  subcalendarId: 12333159,
  eventType: 'created',
  startsAt: '2026-07-24T22:00:00-04:00',
  endsAt: '2026-07-24T23:00:00-04:00',
  title: 'Test Tebra sync 7/20/26',
};

await routeEvent(normalized);
console.log('Replay complete.');
