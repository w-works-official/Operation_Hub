Deno.serve(() => {
  return new Response(JSON.stringify({ ok: false, error: 'migration_disabled' }), {
    status: 410,
    headers: { 'content-type': 'application/json' },
  });
});

