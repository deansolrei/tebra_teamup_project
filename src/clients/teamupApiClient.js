import axios from 'axios';
import { config } from '../config.js';
const client = axios.create({
  baseURL: config.teamup.baseUrl,
  timeout: 30000,
  headers: {
    'Teamup-Token': config.teamup.apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});
function calendarPath(path) {
  return `/${config.teamup.apiCalendarKey}${path}`;
}
function compactParams(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}
function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}
export async function getEvents({
  startDate,
  endDate,
  updatedSince,
  subcalendarId,
} = {}) {
  const params = compactParams({ startDate, endDate, updatedSince });
  if (subcalendarId !== undefined && subcalendarId !== null) {
    params.subcalendarId = Array.isArray(subcalendarId) ? subcalendarId : [subcalendarId];
  }
  const response = await client.get(calendarPath('/events'), { params });
  return response.data;
}
export async function getEvent(eventId) {
  if (!eventId) {
    throw new Error('eventId is required');
  }
  const response = await client.get(calendarPath(`/events/${eventId}`));
  return response.data;
}
export async function createEvent(event) {
  ensureObject(event, 'event');
  const response = await client.post(
    calendarPath('/events'),
    sanitizeEventPayload(event)
  );
  return response.data;
}
export async function updateEvent(eventId, event) {
  if (!eventId) {
    throw new Error('eventId is required');
  }
  ensureObject(event, 'event');
  const response = await client.put(
    calendarPath(`/events/${eventId}`),
    sanitizeEventPayload(event)
  );
  return response.data;
}
export async function deleteEvent(eventId) {
  if (!eventId) {
    throw new Error('eventId is required');
  }
  const response = await client.delete(calendarPath(`/events/${eventId}`));
  return response.data;
}
function sanitizeEventPayload(event) {
  return compactParams({
    title: event.title,
    start_dt: event.start_dt,
    end_dt: event.end_dt,
    notes: event.notes,
    subcalendar_id: event.subcalendar_id,
    all_day: event.all_day,
    tz: event.tz || config.timezone,
    who: event.who,
    location: event.location,
    rrule: event.rrule,
    custom: event.custom,
  });
}
