import { getEvents } from './src/clients/teamupApiClient.js';
import { routeEvent } from './src/services/appointmentSyncService.js';
import { config } from './src/config.js';

const subcalendarId = Number(process.argv[2]);
const days = Number(process.argv[3]) || 90;

if (!subcalendarId) {
  console.error('Usage: node backfill-provider.js <subcalendarId> [days=90]');
  process.exit(1);
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const start = new Date();
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  const startDate = fmtDate(start);
  const endDate = fmtDate(end);

  console.log(`[backfill] subcalendar ${subcalendarId}, window ${startDate} -> ${endDate}, DRY_RUN=${config.sync.dryRun}`);

  const data = await getEvents({ startDate, endDate, subcalendarId });
  const events = data?.events || [];
  console.log(`[backfill] Teamup returned ${events.length} events`);

  let failed = 0;
  for (const ev of events) {
    const normalized = {
      teamupEventId: ev.id,
      subcalendarId,
      eventType: 'created',
      startsAt: ev.start_dt,
      endsAt: ev.end_dt,
      title: ev.title,
    };
    try {
      await routeEvent(normalized);
    } catch (err) {
      failed++;
      console.error(`[backfill] FAILED for event ${ev.id}: ${err.message}`);
    }
  }
  console.log(`[backfill] Done. ${events.length} events processed, ${failed} failed.`);
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});
