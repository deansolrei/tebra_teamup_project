import { config } from '../config.js';
import { normalizeTeamupEvent, verifyTeamupWebhook, isTeamupHandshakePayload } from '../utils/teamupWebhook.js';
import { routeEvent } from '../services/appointmentSyncService.js';

// Two-layer calendar guard:
//   PARENT_CALENDAR_KEY  — the top-level Teamup calendar key (payload.calendar).
//                          Matches TEAMUP_CALENDAR_ID in .env.
//   SOURCE_SUBCALENDAR_ID — numeric ID of the ONE subcalendar to sync ("JJ Mac no details").
//                           All other subcalendars in the same parent are ignored.
//
// ⚠️  Verify SOURCE_SUBCALENDAR_ID against your Teamup settings if events are
//     unexpectedly ignored or processed — confirmed from real webhook payload 2026-06-03.
const PARENT_CALENDAR_KEY   = 'i5eg7g';      // top-level calendar key (from .env TEAMUP_CALENDAR_ID)
const SOURCE_SUBCALENDAR_ID = 12333159;      // subcalendar that fires in all webhook payloads for this calendar
                                             // NOTE: 20384076 is the Teamup sharing LINK config ID (different thing)

export async function handleTeamupWebhook(req, res) {
    try {
        const rawBody = req.rawBody;
        const signature =
            req.get('X-Teamup-Signature') ||
            req.get('Teamup-Signature') ||
            req.get('x-teamup-signature') ||
            '';
        const timestamp =
            req.get('X-Teamup-Timestamp') ||
            req.get('Teamup-Timestamp') ||
            req.get('x-teamup-timestamp') ||
            '';

        const bodyText = Buffer.isBuffer(rawBody)
            ? rawBody.toString('utf8')
            : typeof rawBody === 'string'
                ? rawBody
                : JSON.stringify(req.body ?? {});

        console.log('Incoming Teamup webhook:', {
            method: req.method,
            url: req.originalUrl,
            signaturePresent: Boolean(signature),
            timestampPresent: Boolean(timestamp),
            bodyLength: bodyText.length,
            skipVerify: config.teamup.skipSignatureVerify,
            bodyPreview: bodyText.slice(0, 300),
        });

        // 1. Verify signature (unless TEAMUP_SKIP_SIGNATURE_VERIFY=true)
        const isValid = config.teamup.skipSignatureVerify
            ? true
            : verifyTeamupWebhook({ rawBody: bodyText, signature, timestamp });

        if (!isValid) {
            console.warn('Teamup webhook rejected: invalid signature');
            return res.status(401).json({ ok: false, error: 'Invalid Teamup signature' });
        }

        const payload = req.body ?? {};

        // 2. Handshake / verification ping
        if (isTeamupHandshakePayload(payload)) {
            console.log('Teamup handshake received (calendar:', payload.calendar, ')');
            return res.status(200).json({ ok: true, handshake: true });
        }

        const dispatches = Array.isArray(payload?.dispatch)
            ? payload.dispatch
            : payload?.dispatch
                ? [payload.dispatch]
                : [];

        const hasEventPayload =
            Boolean(payload?.event) ||
            dispatches.some((item) => item && typeof item === 'object' && item.event);

        if (!hasEventPayload) {
            console.log('Teamup webhook: no event payload, treating as ping');
            return res.status(200).json({ ok: true, handshake: true });
        }

        // 3. Ack immediately so Teamup doesn't retry-storm
        res.status(200).json({ ok: true, received: true });

        // 4. Process asynchronously after ack
        setImmediate(async () => {
            try {
                await _processWebhookPayload(payload);
            } catch (err) {
                console.error('Async webhook processing failed:', err.message, err.stack);
            }
        });

    } catch (error) {
        console.error('Teamup webhook handler error:', {
            message: error.message,
            stack: error.stack,
        });
        if (!res.headersSent) {
            return res.status(500).json({ ok: false, error: error.message || 'Internal server error' });
        }
    }
}

async function _processWebhookPayload(payload) {
    const dispatches = Array.isArray(payload?.dispatch)
        ? payload.dispatch
        : payload?.dispatch
            ? [payload.dispatch]
            : [];

    // Support single-event format (no dispatch array)
    if (dispatches.length === 0 && payload?.event) {
        dispatches.push({ event: payload.event, trigger: payload.event_type || 'unknown' });
    }

    for (let i = 0; i < dispatches.length; i++) {
        const dispatchPayload = { ...payload, dispatch: [dispatches[i]], dispatchIndex: i };

        let normalized;
        try {
            normalized = normalizeTeamupEvent(dispatchPayload);
        } catch (err) {
            console.error(`Failed to normalize dispatch[${i}]:`, err.message);
            continue;
        }

        console.log('Processing Teamup event:', {
            deliveryId: normalized.deliveryId,
            eventType: normalized.eventType,
            rawEventType: normalized.rawEventType,
            teamupEventId: normalized.teamupEventId,
            calendarId: normalized.calendarId,
            subcalendarId: normalized.subcalendarId,
            title: normalized.title,
            startsAt: normalized.startsAt,
            endsAt: normalized.endsAt,
        });

        // 5. Two-layer calendar guard:
        //    Layer 1 — top-level calendar key must match i5eg7g
        //    Layer 2 — subcalendar_id must be the "JJ Mac no details" subcalendar
        if (normalized.calendarId !== PARENT_CALENDAR_KEY) {
            console.log(`Ignoring event: wrong parent calendar ${normalized.calendarId} (expected ${PARENT_CALENDAR_KEY})`);
            continue;
        }
        if (Number(normalized.subcalendarId) !== SOURCE_SUBCALENDAR_ID) {
            console.log(`Ignoring event: subcalendar ${normalized.subcalendarId} is not the sync source (expected ${SOURCE_SUBCALENDAR_ID})`);
            continue;
        }

        // 6. Skip recurring series definitions.
        //    When rrule is present, the event represents a full recurring series
        //    (start_dt = first occurrence, end_dt = series end or 9999).
        //    These can't map cleanly to a single Tebra appointment.
        //    Individual non-recurring blocks are synced instead.
        if (normalized.rrule) {
            console.log(`Ignoring recurring series event ${normalized.teamupEventId} (rrule: ${normalized.rrule.slice(0, 40)})`);
            continue;
        }

        // 7. Skip events that have already ended (past events).
        //    Allow a 2-hour grace window for events that just finished.
        const endTime = normalized.endsAt ? new Date(normalized.endsAt) : null;
        const nowMinus2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
        if (endTime && endTime < nowMinus2h) {
            console.log(`Ignoring past event ${normalized.teamupEventId} (ended ${normalized.endsAt})`);
            continue;
        }

        // 8. Route to the correct Tebra operation.
        //    Wrapped per-event so a Tebra failure on one dispatch doesn't
        //    abort processing of the remaining events in the batch.
        try {
            const result = await routeEvent(normalized);
            console.log('routeEvent result:', JSON.stringify(result, null, 2));
        } catch (err) {
            console.error(`routeEvent failed for event ${normalized.teamupEventId}:`, err.message);
        }
    }
}
