(function(g){
 'use strict';
 const contract='smartstore-basic-facts-v2', provenanceContract='hub-rule-provenance-v2';
 const M=()=>g.HubValueStateModel;
 // In this version only the Smartstore basic-discount display label and its
 // internal input origin are metadata. Every other condition remains a fact.
 function facts(tuple){
  if(!tuple||!M().priceTuple(tuple))throw Error('invalid price facts');
  const result=structuredClone(tuple);
  result.terms=result.terms.map(term=>{
   if(term.term_key!=='basic'||term.term_type!=='basic')throw Error('unsupported discount fact schema');
   const {title,input_source,...operative}=term;return operative;
  });
  return result;
 }
 function operation({sku,identity,baseline,carrier,target,record,sourceRowNo,fileName}){
  if(!/^10000-[123]$/.test(sku))throw Error('outside verification scope');
  if(record.status!=='calculated'||record.error||!record.result_details?.input_fingerprint||!record.rule_versions?.length)throw Error('missing active Rule proof');
  if(!M().equal(record.result_details.discount_terms||[],target.terms)||Number(record.value)!==target.final)throw Error('internal calculation proof mismatch');
  const effective=facts(target);
  return {sku,product_code:identity.product_code,option_code:identity.option_code,field:'price',baseline_before:structuredClone(baseline),carrier_before:structuredClone(carrier),effective_target:effective,disposition:'CHANGE',provenance:'calculated',generation_id:record.generation_id,freshness:'fresh',current_input_fingerprint:record.result_details.input_fingerprint,proof_contract:contract,seller_facts_proof:{contract,target:effective},internal_provenance_proof:{contract:provenanceContract,price:structuredClone(target),generation_id:record.generation_id,input_fingerprint:record.result_details.input_fingerprint,rule_versions:structuredClone(record.rule_versions)},source_row_no:sourceRowNo,source_file_name:fileName};
 }
 function verify(op,reopened){
  if(op.proof_contract!==contract||op.seller_facts_proof?.contract!==contract||op.internal_provenance_proof?.contract!==provenanceContract)throw Error('invalid proof contract');
  if(!M().equal(facts(op.internal_provenance_proof.price),op.effective_target)||!M().equal(op.seller_facts_proof.target,op.effective_target))throw Error('disconnected proofs');
  const actual=facts(reopened);if(!M().equal(actual,op.effective_target))throw Error('seller facts mismatch');
  return {...structuredClone(op),serialized_after:actual};
 }
 function pending(baseline,target){return !M().equal(facts(baseline),facts(target));}
 g.HubPriceProof=Object.freeze({contract,provenanceContract,facts,operation,verify,pending});
})(typeof window==='undefined'?globalThis:window);

