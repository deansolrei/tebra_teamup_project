import express from 'express';
import { handleTeamupWebhook } from '../controllers/syncController.js';

export const teamupWebhookRouter = express.Router();

teamupWebhookRouter.post('/', handleTeamupWebhook);

teamupWebhookRouter.get('/', (req, res) => {
    res.status(200).json({
        ok: true,
        route: 'teamup-webhook',
        message: 'POST Teamup webhook endpoint is live',
    });
});
