import axios from 'axios';
import { config } from './src/config.js';

const calendarId = 'kssw3x47m7gisui4yt'; // verified working access key
const apiKey = config.teamup.apiKey;
const baseUrl = config.teamup.baseUrl;
const LORI_SUBCALENDAR_ID = 14920229;

const client = axios.create({
  baseURL: baseUrl,
  headers: { 'Teamup-Token': apiKey, Accept: 'application/json' },
  timeout: 30000,
});

async function main() {
  const qs = `startDate=2026-07-01&endDate=2026-10-01&subcalendarId[]=${LORI_SUBCALENDAR_ID}`;
  const url = `/${calendarId}/events?${qs}`;
  console.log('GET', baseUrl + url);
  try {
    const res = await client.get(url);
    const events = res.data?.events || [];
    console.log(`Got ${events.length} events\n`);
    for (const ev of events) {
      console.log(JSON.stringify({
        id: ev.id, title: ev.title, start_dt: ev.start_dt, end_dt: ev.end_dt,
        rrule: ev.rrule, remote_id: ev.remote_id, series_id: ev.series_id,
        ristart_dt: ev.ristart_dt, rsstart_dt: ev.rsstart_dt,
      }));
    }
  } catch (err) {
    console.error('FAILED:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
  }
}
main();
