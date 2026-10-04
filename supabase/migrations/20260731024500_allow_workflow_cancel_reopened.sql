alter table public.workflow_item_events
  drop constraint workflow_item_events_event_type_check;

alter table public.workflow_item_events
  add constraint workflow_item_events_event_type_check
  check (
    event_type = any (
      array[
        'picked'::text,
        'pick_unchecked'::text,
        'shortage_created'::text,
        'shortage_qty_changed'::text,
        'shortage_repick_completed'::text,
        'inspection_completed'::text,
        'inspection_reopened'::text,
        'cancelled'::text,
        'cancel_reopened'::text
      ]
    )
  ) not valid;

alter table public.workflow_item_events
  validate constraint workflow_item_events_event_type_check;

alter table public.workflow_invoice_events
  drop constraint workflow_invoice_events_event_type_check;

alter table public.workflow_invoice_events
  add constraint workflow_invoice_events_event_type_check
  check (
    event_type = any (
      array[
        'hold_created'::text,
        'hold_released'::text,
        'cs_pending'::text,
        'cs_resolved'::text,
        'shortage_invoice_repick_completed'::text,
        'inspection_completed'::text,
        'inspection_reopened'::text,
        'cancelled'::text,
        'cancel_reopened'::text
      ]
    )
  ) not valid;

alter table public.workflow_invoice_events
  validate constraint workflow_invoice_events_event_type_check;
