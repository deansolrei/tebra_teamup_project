create extension if not exists pgcrypto;

create table if not exists webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  delivery_id text not null,
  event_type text not null,
  raw_payload jsonb not null,
  processing_status text not null default 'received',
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source_system, delivery_id)
);

create table if not exists event_mappings (
  id uuid primary key default gen_random_uuid(),
  teamup_event_id text unique,
  tebra_appointment_id text unique,
  teamup_calendar_id text,
  teamup_subcalendar_id text,
  sync_direction text not null,
  sync_status text not null default 'active',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sync_cursor (
  id uuid primary key default gen_random_uuid(),
  system_name text not null,
  cursor_type text not null,
  cursor_value text not null,
  updated_at timestamptz not null default now(),
  unique (system_name, cursor_type)
);

create table if not exists sync_audit_log (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid references event_mappings(id) on delete set null,
  direction text not null,
  operation text not null,
  source_system text not null,
  destination_system text not null,
  request_payload jsonb,
  response_payload jsonb,
  status_code integer,
  succeeded boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_webhook_deliveries_status on webhook_deliveries(processing_status, received_at);
create index if not exists idx_event_mappings_status on event_mappings(sync_status, last_synced_at);
create index if not exists idx_sync_audit_log_created_at on sync_audit_log(created_at desc);

alter table event_mappings
  add column if not exists last_origin_system text,
  add column if not exists last_origin_token text,
  add column if not exists source_last_modified_at timestamptz;

create index if not exists idx_event_mappings_origin_token on event_mappings(last_origin_token);

alter table webhook_deliveries
  add column if not exists source_event_id text;

create index if not exists idx_webhook_deliveries_source_event on webhook_deliveries(source_system, source_event_id);

