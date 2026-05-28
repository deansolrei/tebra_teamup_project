import dotenv from 'dotenv';
dotenv.config();

import {
  getServiceLocations,
  getAppointments,
  getAppointment,
} from '../src/tebraSoapClient.js';

async function main() {
  try {
    const serviceLocations = await getServiceLocations({});
    console.log('SERVICE LOCATIONS:');
    console.dir(serviceLocations, { depth: 10 });

    const appointments = await getAppointments({
      startIso: '2026-05-23T00:00:00.000Z',
      endIso: '2026-05-24T00:00:00.000Z',
    });
    console.log('\nAPPOINTMENTS:');
    console.dir(appointments, { depth: 10 });

    const appointmentId = process.env.TEST_TEBRA_APPOINTMENT_ID;

    if (appointmentId) {
      const appointment = await getAppointment({ appointmentId });
      console.log('\nSINGLE APPOINTMENT:');
      console.dir(appointment, { depth: 10 });
    } else {
      console.log('\nSet TEST_TEBRA_APPOINTMENT_ID in .env to test GetAppointment.');
    }
  } catch (error) {
    console.error('\nTEST FAILED');
    console.error(error?.message || error);
    process.exit(1);
  }
}

main();

