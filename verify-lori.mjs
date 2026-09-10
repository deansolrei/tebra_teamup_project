import { getAllMappings } from './src/lib/mappingStore.js';

const all = Object.values(getAllMappings()).filter(r => r.providerId === 4);
const noId = all.filter(r => r.tebraAppointmentId == null);
const notActive = all.filter(r => r.status !== 'active');

console.log('Total Lori records:', all.length);
console.log('Missing tebraAppointmentId:', noId.length);
console.log('Not active:', notActive.length, notActive.map(r => ({ id: r.teamupEventId, status: r.status })));
