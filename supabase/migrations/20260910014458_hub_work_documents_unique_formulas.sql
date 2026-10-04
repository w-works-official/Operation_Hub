create unique index hub_work_documents_formula_title_idx on operations_private.hub_work_documents(kind,title) where kind in ('formula','price-links');
