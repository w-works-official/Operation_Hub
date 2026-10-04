-- Remove the exact synthetic row used to verify the public-role insert and
-- update path for the Alimtalk exclusion deployment.

delete from public.cs_cases
where ord_no = '__codex_qa_alimtalk_20260929_1508'
  and item_no = 'item-1'
  and case_type = 'template_override'
  and updated_by = 'codex-deploy-qa';
