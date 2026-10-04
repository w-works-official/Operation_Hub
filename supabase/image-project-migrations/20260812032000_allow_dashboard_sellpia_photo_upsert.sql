-- Applied to image project: bpgvqmtsjgegnrdzmpep (System_v1)
-- Public read already exists. Dashboard upsert needs INSERT + SELECT + UPDATE.

create policy "dashboard sellpia photos insert"
on storage.objects
for insert
to anon, authenticated
with check (
  bucket_id = 'product-images'
  and name ~ '^sellpia/[^/]+[.]jpg$'
);

create policy "dashboard sellpia photos update"
on storage.objects
for update
to anon, authenticated
using (
  bucket_id = 'product-images'
  and name ~ '^sellpia/[^/]+[.]jpg$'
)
with check (
  bucket_id = 'product-images'
  and name ~ '^sellpia/[^/]+[.]jpg$'
);
