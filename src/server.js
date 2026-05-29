import express from 'express';
import { config } from './config.js';
import { teamupWebhookRouter } from './routes/teamupWebhookRoute.js';

const app = express();

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'tebra-teamup-project',
    env: config.app.env,
  });
});

app.use('/webhooks/teamup', teamupWebhookRouter);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not found',
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', {
    message: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    ok: false,
    error: 'Unhandled server error',
  });
});

app.listen(config.app.port, () => {
  console.log(`Server listening on port ${config.app.port}`);
  console.log(`Teamup webhook endpoint: /webhooks/teamup`);
});
