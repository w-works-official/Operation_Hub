-- Full-filter SKU enumeration searches original names across all sources, unlike one-page reads.
-- Keep the shared API role timeout unchanged; this operator-session read is bounded to 50,000 SKUs.
alter function public.hub_filtered_skus_v1(text,integer,integer,text,text[],text,text,jsonb,text[],boolean) set statement_timeout='15s';
notify pgrst,'reload schema';
