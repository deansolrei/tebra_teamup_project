import express from 'express';
import { config } from './config.js';
import {
  normalizeTeamupEvent,
  verifyTeamupWebhook,
  parseTeamupRawBody,
  isTeamupHandshakePayload,
} from './teamupWebhook.js';
import { processTeamupWebhook } from './syncService.js';
import { runReverseSyncWindow } from './reverseSyncService.js';

const app = express();

console.log('STARTUP MARKER 2026-05-25 8:56 PM');
console.log('cwd:', process.cwd());
console.log('server file:', import.meta.url);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tebra-teamup-middleware',
    routingMode: 'teamup-centric',
    reverseSyncEnabled: config.sync.enableReverseSync,
  });
});

app.post('/webhooks/teamup', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.from(req.body || '');

  const signature =
    req.header('Teamup-Signature') ||
    req.header('teamup-signature') ||
    req.header('x-teamup-signature') ||
    '';

  const timestamp =
    req.header('Teamup-Timestamp') ||
    req.header('teamup-timestamp') ||
    req.header('x-teamup-timestamp') ||
    '';

  console.log('Teamup headers:', req.headers);
  console.log('Raw body:', rawBody.toString('utf8'));

  const payload = parseTeamupRawBody(rawBody);

  if (!payload) {
    console.error('teamup webhook json parse failed');
    return res.status(400).json({ error: 'invalid json payload' });
  }

  if (isTeamupHandshakePayload(payload)) {
    console.log('teamup webhook handshake accepted', {
      calendarId: payload.calendar ?? null,
      timestamp,
    });

    return res.status(200).json({
      accepted: true,
      verification: true,
      handshake: true,
      calendarId: payload.calendar ?? null,
      eventCount: 0,
    });
  }

  if (!signature) {
    console.warn('teamup webhook rejected: missing signature', {
      hasSignature: Boolean(signature),
    });

    return res.status(401).json({
      error: 'missing webhook signature',
    });
  }

  let isValid = false;
  try {
    isValid = verifyTeamupWebhook({
      rawBody,
      signature,
      timestamp,
      secret: config.teamup.webhookSecret,
    });
  } catch (error) {
    console.error('teamup webhook verification failed', error);
    return res.status(401).json({ error: 'invalid webhook signature' });
  }

  if (!isValid) {
    console.warn('teamup webhook rejected: invalid signature', {
      deliveryId: payload.id ?? null,
      timestamp,
    });
    return res.status(401).json({ error: 'invalid webhook signature' });
  }

  const dispatches = Array.isArray(payload.dispatch) ? payload.dispatch : [];

  console.log('teamup webhook verified', {
    deliveryId: payload.id ?? null,
    calendarId: payload.calendar ?? null,
    dispatchCount: dispatches.length,
    timestamp,
  });

  if (dispatches.length === 0) {
    console.log('teamup webhook verification ping accepted', {
      deliveryId: payload.id ?? null,
      calendarId: payload.calendar ?? null,
      timestamp,
    });

    return res.status(200).json({
      accepted: true,
      verification: true,
      deliveryId: payload.id ?? null,
      eventCount: 0,
    });
  }

  let events;
  try {
    events = dispatches.map((item, index) => {
      const event = normalizeTeamupEvent({
        id: `${payload.id}:${index}`,
        delivery_id: payload.id,
        calendar: payload.calendar,
        dispatch: [item],
        raw: rawBody.toString('utf8'),
        dispatchIndex: index,
      });

      console.log('teamup webhook normalized event', {
        deliveryId: event.deliveryId,
        dispatchIndex: event.dispatchIndex,
        rawEventType: event.rawEventType,
        eventType: event.eventType,
        teamupEventId: event.teamupEventId,
        remoteId: event.remoteId,
        subcalendarId: event.subcalendarId,
        startsAt: event.startsAt,
      });

      return event;
    });
  } catch (error) {
    console.error('teamup webhook normalization failed', error);
    return res.status(400).json({ error: 'invalid webhook event format' });
  }

  res.status(202).json({
    accepted: true,
    deliveryId: payload.id ?? null,
    eventCount: events.length,
  });

  setImmediate(async () => {
    for (const event of events) {
      try {
        console.log('teamup webhook processing started', {
          deliveryId: event.deliveryId,
          dispatchIndex: event.dispatchIndex,
          teamupEventId: event.teamupEventId,
          eventType: event.eventType,
          rawEventType: event.rawEventType,
          remoteId: event.remoteId,
        });

        await processTeamupWebhook(event);

        console.log('teamup webhook processing completed', {
          deliveryId: event.deliveryId,
          dispatchIndex: event.dispatchIndex,
          teamupEventId: event.teamupEventId,
          eventType: event.eventType,
          remoteId: event.remoteId,
        });
      } catch (error) {
        console.error('teamup webhook processing failed', {
          deliveryId: event.deliveryId,
          dispatchIndex: event.dispatchIndex,
          teamupEventId: event.teamupEventId,
          eventType: event.eventType,
          rawEventType: event.rawEventType,
          remoteId: event.remoteId,
          error,
        });
      }
    }
  });
});

app.post('/jobs/reverse-sync', express.json(), async (req, res) => {
  if (!config.sync.enableReverseSync) {
    return res.status(409).json({
      ok: false,
      error: 'reverse sync disabled',
      message: 'Reverse sync is disabled in Teamup-centric mode.',
    });
  }

  const startIso =
    req.body?.startIso ||
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const endIso =
    req.body?.endIso ||
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    await runReverseSyncWindow({ startIso, endIso });
    return res.json({ ok: true, startIso, endIso });
  } catch (error) {
    console.error('manual reverse sync failed', error);
    return res.status(500).json({ error: 'reverse sync failed' });
  }
});

app.listen(config.port, () => {
  console.log(`middleware listening on :${config.port}`);
  console.log('Teamup-centric routing enabled');
  console.log(`Reverse sync enabled: ${config.sync.enableReverseSync}`);
});

if (config.sync.enableReverseSync) {
  setInterval(async () => {
    const startIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const endIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    try {
      await runReverseSyncWindow({ startIso, endIso });
    } catch (error) {
      console.error('scheduled reverse sync failed', error);
    }
  }, config.sync.pollIntervalMs);
}
