-- Virtual platform inputs are resolved from the current shared product calculation.
-- They are input-only fields; assignment target constraints remain unchanged.
alter table operations_private.hub_rules drop constraint hub_rules_source_field_check;
alter table operations_private.hub_rules add constraint hub_rules_source_field_check check (
 source_field in ('purchase_price','source_base_price','actual_inbound_cost','basis_sku_price','calculated_base_price','system_stock','calculated_stock','platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price','platform_option_input','platform_final_input')
);
alter table operations_private.hub_field_references drop constraint hub_field_references_source_field_check;
alter table operations_private.hub_field_references add constraint hub_field_references_source_field_check check (
 source_field in ('purchase_price','source_base_price','actual_inbound_cost','basis_sku_price','calculated_base_price','system_stock','calculated_stock','platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price','platform_option_input','platform_final_input')
);
notify pgrst,'reload schema';
