-- Virtual-option QA was replaced by live matrix test products.
-- Keep reusable price tags/sets, but remove the isolated QA-only storage.

drop view if exists public.operations_hub_price_rule_qa_live;
drop table if exists public.operations_hub_price_rule_qa_components;
drop table if exists public.operations_hub_price_rule_qa_cases;
