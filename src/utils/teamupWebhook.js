import crypto from 'crypto';
import { config } from './config.js';

export function parseTeamupRawBody(rawBody) {
  if (!rawBody) return null;

  try {
    const bodyBuffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(String(rawBody), 'utf8');

    return JSON.parse(bodyBuffer.toString('utf8'));
  } catch (error) {
    console.error('Failed to parse Teamup raw body:', error.message);
    return null;
  }
}

export function isTeamupHandshakePayload(payload) {
  return Boolean(
    payload &&
    payload.calendar === 'identifier' &&
    Array.isArray(payload.dispatch) &&
    payload.dispatch.length === 0
  );
}

export function verifyTeamupWebhook({ rawBody, signature, timestamp, secret }) {
  const received = String(signature || '').trim().toLowerCase();
  const ts = String(timestamp || '').trim();
  const signingSecret = String(secret || config.teamup.webhookSecret || '').trim();

  if (!rawBody || !received || !signingSecret) {
    console.log('Teamup verifier missing input:', {
      hasRawBody: Boolean(rawBody),
      hasSignature: Boolean(received),
      hasTimestamp: Boolean(ts),
      hasSecret: Boolean(signingSecret),
    });
    return false;
  }

  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody), 'utf8');

  const bodyText = bodyBuffer.toString('utf8');

  const candidates = {
    raw_body: crypto
      .createHmac('sha256', signingSecret)
      .update(bodyBuffer)
      .digest('hex'),

    timestamp_dot_body: crypto
      .createHmac('sha256', signingSecret)
      .update(`${ts}.${bodyText}`, 'utf8')
      .digest('hex'),

    timestamp_body: crypto
      .createHmac('sha256', signingSecret)
      .update(`${ts}${bodyText}`, 'utf8')
      .digest('hex'),

    body_dot_timestamp: crypto
      .createHmac('sha256', signingSecret)
      .update(`${bodyText}.${ts}`, 'utf8')
      .digest('hex'),
  };

  const matched = Object.entries(candidates).find(([, expected]) =>
    safeEqualHex(expected, received)
  );

  console.log('Teamup verification result:', {
    timestamp: ts || null,
    rawBodyType: Buffer.isBuffer(rawBody) ? 'buffer' : typeof rawBody,
    rawBodyLength: bodyBuffer.length,
    secretLength: signingSecret.length,
    signaturePrefix: received.slice(0, 12),
    matches: matched ? matched[0] : null,
    candidatePrefixes: Object.fromEntries(
      Object.entries(candidates).map(([key, value]) => [key, value.slice(0, 12)])
    ),
  });

  return Boolean(matched);
}

export function normalizeTeamupEvent(payload) {
  const dispatches = Array.isArray(payload?.dispatch)
    ? payload.dispatch
    : payload?.dispatch
      ? [payload.dispatch]
      : [];

  if (dispatches.length === 0 && !payload?.event) {
    throw new Error('No Teamup dispatch/event payload found');
  }

  const firstDispatch = dispatches[0] || null;
  const eventPayload = firstDispatch?.event || payload?.event || null;

  if (!eventPayload) {
    throw new Error('No Teamup event object found');
  }

  const rawEventType = String(
    firstDispatch?.trigger ||
    payload?.event_type ||
    payload?.action ||
    payload?.type ||
    ''
  ).trim();

  const eventType = normalizeEventType(rawEventType);

  return {
    deliveryId: payload?.delivery_id || payload?.id || crypto.randomUUID(),
    dispatchIndex: Number.isInteger(payload?.dispatchIndex) ? payload.dispatchIndex : 0,
    eventType,
    rawEventType,
    teamupEventId: eventPayload?.id || null,
    calendarId: payload?.calendar || payload?.calendar_id || null,
    subcalendarId:
      eventPayload?.subcalendar_id ||
      firstSubcalendarId(eventPayload?.subcalendar_ids) ||
      null,
    startsAt: eventPayload?.start_dt || null,
    endsAt: eventPayload?.end_dt || null,
    updatedAt:
      eventPayload?.update_dt ||
      eventPayload?.delete_dt ||
      eventPayload?.creation_dt ||
      null,
    title: eventPayload?.title || '',
    location: eventPayload?.location || '',
    notes: eventPayload?.notes || '',
    remoteId: eventPayload?.remote_id || null,
    seriesId: eventPayload?.series_id || null,
    raw: typeof payload?.raw === 'string' ? payload.raw : JSON.stringify(payload),
    dispatches,
  };
}

function normalizeEventType(value) {
  const normalized = String(value || '').toLowerCase();

  if (['created', 'create', 'event.created'].includes(normalized)) return 'created';
  if (['modified', 'modify', 'event.modified', 'updated', 'update'].includes(normalized)) return 'updated';
  if (['removed', 'remove', 'deleted', 'delete', 'event.removed', 'event.deleted'].includes(normalized)) return 'deleted';
  if (['cancelled', 'canceled', 'cancel', 'event.cancelled', 'event.canceled'].includes(normalized)) return 'cancelled';

  return 'unknown';
}

function firstSubcalendarId(value) {
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return null;
}

function safeEqualHex(expected, received) {
  if (!expected || !received) return false;
  if (expected.length !== received.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );
  } catch {
    return false;
  }
}
