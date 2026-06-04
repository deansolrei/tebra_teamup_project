# Tebra-Teamup Middleware Skeleton

This starter project contains three core pieces:
- Teamup webhook receiver (`src/server.js` + `src/teamupWebhook.js`)
- Tebra SOAP client (`src/tebraSoapClient.js`)
- PostgreSQL state schema (`db/schema.sql`)

## Intended flow
1. Teamup sends webhook notifications for event create/update/delete.
2. Middleware verifies the signature, normalizes the payload, and records the delivery.
3. Middleware looks up the Teamup-to-Tebra mapping.
4. Middleware creates, updates, or cancels the Tebra appointment through SOAP.
5. Middleware writes audit and mapping state so retries stay idempotent.

## Gaps to fill
- Replace placeholder SOAP action names and request body elements with the exact Tebra WSDL contract.
- Map Teamup event fields to Tebra appointment, provider, patient, and facility fields.
- Add outbound Teamup API client for reverse sync from Tebra to Teamup.
- Add retry queue, dead-letter handling, and loop-prevention markers.
- Add auth, logging, tests, and deployment configuration.

## Quick start
```bash
npm install
psql "$DATABASE_URL" -f db/schema.sql
npm run dev


## Deployment
Production server: Mac Mini (SBH Server) - sync.solreibehavioralhealth.com
