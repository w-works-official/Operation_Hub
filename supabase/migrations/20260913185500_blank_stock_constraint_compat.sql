-- Fresh-install compatibility for the earlier blank-stock migration.
-- Production currently records preserved blanks as cancelled + incomplete + preservedBlank=true,
-- but allowing the historical label prevents the old migration body from violating the constraint
-- during a clean replay before later function definitions take effect.
alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_target_safety_state_check;

alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_target_safety_state_check
  check (target_safety_state in ('ready','conflict','incomplete','preserved_blank'));
