-- Preserve the session gate and every operation contract. Only disambiguate
-- the SQL member assignment alias from the PL/pgSQL assignment record.
do $migration$
declare definition text; old_fragment text := 'join operations_private.hub_product_price_assignments a on a.product_code=p.sellpia_product_code join operations_private.hub_product_price_rules x on x.id=a.rule_id'; new_fragment text := 'join operations_private.hub_product_price_assignments member_assignment on member_assignment.product_code=p.sellpia_product_code join operations_private.hub_product_price_rules x on x.id=member_assignment.rule_id';
begin
 definition := pg_get_functiondef('operations_private.hub_product_price_v1(text,text,jsonb)'::regprocedure);
 if position(old_fragment in definition)=0 then raise exception 'representative members alias migration precondition failed'; end if;
 execute replace(definition,old_fragment,new_fragment);
end $migration$;
