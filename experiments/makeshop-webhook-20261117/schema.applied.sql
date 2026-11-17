-- Applied to existing company System_v1 on 2026-11-17.
-- Dedicated non-API-exposed namespace. No changes to existing Operation Hub objects.
create schema makeshop;
revoke all on schema makeshop from public;
revoke all on schema makeshop from anon;
revoke all on schema makeshop from authenticated;

create table makeshop.webhook_inbox (
  client_id text not null,
  webhook_id text not null,
  event_id text not null,
  event_type text not null,
  shop_id text not null,
  occurred_at text,
  webhook_timestamp bigint not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processing_status text not null default 'pending'
    check (processing_status in ('pending','processing','processed','failed')),
  processed_at timestamptz,
  last_error text,
  constraint makeshop_webhook_inbox_pkey primary key (client_id, webhook_id),
  constraint makeshop_webhook_inbox_payload_object check (jsonb_typeof(payload) = 'object')
);

create index makeshop_webhook_inbox_pending_idx
  on makeshop.webhook_inbox (processing_status, received_at);
alter table makeshop.webhook_inbox enable row level security;
revoke all on table makeshop.webhook_inbox from public;
revoke all on table makeshop.webhook_inbox from anon;
revoke all on table makeshop.webhook_inbox from authenticated;

comment on table makeshop.webhook_inbox is
  'Private, durably acknowledged Makeshop webhook inbox; event processing is separate.';
