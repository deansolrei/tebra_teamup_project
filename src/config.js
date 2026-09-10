import dotenv from 'dotenv';
dotenv.config();
function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}
function optional(name, fallback = '') {
  const value = process.env[name];
  return value === undefined ? fallback : String(value).trim();
}
function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}
function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export const config = {
  app: {
    port: toNumber(process.env.PORT, 3000),
    env: optional('NODE_ENV', 'development'),
  },
  timezone: optional('APP_TIMEZONE', 'America/New_York'),
  teamup: {
    skipSignatureVerify: toBool(process.env.TEAMUP_SKIP_SIGNATURE_VERIFY, false),
    webhookSecret: required('TEAMUP_WEBHOOK_SECRET'),
    calendarId: optional('TEAMUP_CALENDAR_ID'),
    apiKey: optional('TEAMUP_API_KEY'),
    apiCalendarKey: optional('TEAMUP_API_CALENDAR_KEY'),
    baseUrl: optional('TEAMUP_BASE_URL', 'https://api.teamup.com'),
  },
  tebra: {
    soapUrl: optional(
      'TEBRA_SOAP_URL',
      'https://webservice.kareo.com/services/soap/2.1/KareoServices.svc'
    ),
    customerKey: required('TEBRA_CUSTOMER_KEY'),
    username: required('TEBRA_USERNAME'),
    password: required('TEBRA_PASSWORD'),
    practiceId: required('TEBRA_PRACTICE_ID'),
    practiceName: required('TEBRA_PRACTICE_NAME'),
    serviceLocationId: required('TEBRA_SERVICE_LOCATION_ID'),
    serviceLocationName: required('TEBRA_SERVICE_LOCATION_NAME'),
  },
  sync: {
    dryRun: toBool(process.env.SYNC_DRY_RUN, true),
    autoDeleteAfterVerify: toBool(process.env.SYNC_AUTO_DELETE_AFTER_VERIFY, false),
    verifyDelayMs: toNumber(process.env.SYNC_VERIFY_DELAY_MS, 1200),
    testMarker: optional('SYNC_TEST_MARKER', 'TEST - JJ TEAMUP SYNC'),
  },
};
