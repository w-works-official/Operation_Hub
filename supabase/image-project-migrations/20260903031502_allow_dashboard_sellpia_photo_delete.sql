-- Photo library deletion is intentionally limited to the dashboard's Sellpia JPG namespace.
-- The frontend uses a publishable key until the planned company-auth cutover.
drop policy if exists "dashboard sellpia photos delete" on storage.objects;

create policy "dashboard sellpia photos delete"
on storage.objects
for delete
to anon, authenticated
using (
  bucket_id = 'product-images'
  and name ~ '^sellpia/[^/]+[.]jpg$'
);
