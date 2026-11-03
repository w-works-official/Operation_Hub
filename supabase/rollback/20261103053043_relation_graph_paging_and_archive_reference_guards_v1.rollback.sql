-- Rollback only the added reader and reference guards. No operator data writes.
-- Existing public archive RPCs were never replaced and remain unchanged.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop trigger if exists operations_hub_relation_folder_archive_group_guard_v1 on public.operations_hub_relation_folders;
drop trigger if exists operations_hub_relation_node_archive_group_guard_v1 on public.operations_hub_relation_nodes;
drop function if exists operations_private.guard_relation_folder_archive_v1();
drop function if exists operations_private.guard_relation_node_archive_v1();
drop function if exists public.list_operations_hub_relation_graph_page_v1(text,bigint,bigint,bigint,integer,text);

notify pgrst, 'reload schema';
