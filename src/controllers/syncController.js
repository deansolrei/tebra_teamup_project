import { config } from '../config.js';
import { normalizeTeamupEvent, verifyTeamupWebhook } from '../utils/teamupWebhook.js';
import { createVerifyDeleteFromTeamupEvent } from '../services/appointmentSyncService.js';

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

        const isValid = config.teamup.skipSignatureVerify
            ? true
            : verifyTeamupWebhook({
                rawBody: bodyText,
                signature,
                timestamp,
            });

        if (!isValid) {
            return res.status(401).json({
                ok: false,
                error: 'Invalid Teamup signature',
            });
        }

        const payload = req.body ?? {};
        const dispatches = Array.isArray(payload?.dispatch)
            ? payload.dispatch
            : payload?.dispatch
                ? [payload.dispatch]
                : [];

        const hasEventPayload =
            Boolean(payload?.event) ||
            dispatches.some((item) => item && typeof item === 'object' && item.event);

        if (!hasEventPayload) {
            console.log('Teamup webhook verification/handshake request received.', {
                calendar: payload?.calendar || null,
                dispatchCount: dispatches.length,
            });

            return res.status(200).json({
                ok: true,
                handshake: true,
            });
        }


        const normalizedEvent = normalizeTeamupEvent(payload);

        console.log('Normalized Teamup event:', {
            deliveryId: normalizedEvent.deliveryId,
            eventType: normalizedEvent.eventType,
            rawEventType: normalizedEvent.rawEventType,
            teamupEventId: normalizedEvent.teamupEventId,
            title: normalizedEvent.title,
            startsAt: normalizedEvent.startsAt,
            endsAt: normalizedEvent.endsAt,
            subcalendarId: normalizedEvent.subcalendarId,
        });

        const supportedEventTypes = new Set(['created', 'updated', 'deleted', 'cancelled']);

        if (!supportedEventTypes.has(normalizedEvent.eventType)) {
            return res.status(202).json({
                ok: true,
                ignored: true,
                reason: `Unsupported event type: ${normalizedEvent.rawEventType || 'unknown'}`,
            });
        }

        const result = await createVerifyDeleteFromTeamupEvent(normalizedEvent);
        console.log('Sync result:', JSON.stringify(result, null, 2));


        return res.status(200).json({
            ok: true,
            deliveryId: normalizedEvent.deliveryId,
            eventType: normalizedEvent.eventType,
            teamupEventId: normalizedEvent.teamupEventId,
            result,
        });
    } catch (error) {
        console.error('Teamup webhook processing failed:', {
            message: error.message,
            stack: error.stack,
        });

        return res.status(500).json({
            ok: false,
            error: error.message || 'Internal server error',
        });
    }
}
