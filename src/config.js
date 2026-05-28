import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,

  teamup: {
    apiKey: process.env.TEAMUP_API_KEY || '',
    calendarKey: process.env.TEAMUP_CALENDAR_KEY || '',
    webhookSecret: process.env.TEAMUP_WEBHOOK_SECRET || '',
    apiBaseUrl: 'https://api.teamup.com',
  },

  sync: {
    enableReverseSync: String(process.env.ENABLE_REVERSE_SYNC || 'false').toLowerCase() === 'true',
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 300000),
  },

  tebra: {
    soapUrl: process.env.TEBRA_SOAP_URL,
    customerKey: process.env.TEBRA_CUSTOMER_KEY,
    password: process.env.TEBRA_SOAP_PASSWORD,
    username: process.env.TEBRA_SOAP_USERNAME,
    practiceName: process.env.TEBRA_PRACTICE_NAME,
    practiceId: Number(process.env.TEBRA_PRACTICE_ID),
    serviceLocationId: Number(process.env.TEBRA_SERVICE_LOCATION_ID),
    defaultAppointmentMode: process.env.TEBRA_DEFAULT_APPOINTMENT_MODE || 'Telehealth',
  },

  timezone: process.env.DEFAULT_TIMEZONE || 'America/New_York',
};
