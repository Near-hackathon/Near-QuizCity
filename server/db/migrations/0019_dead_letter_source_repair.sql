-- Correct the best-effort 0018 source backfill when more than one cursor source
-- exists for a network/contract. An ambiguous failure must remain non-retryable
-- until an operator identifies its real source; guessing can rewind the wrong
-- cursor and corrupt ingestion order.

with source_counts as (
  select
    network_id,
    contract_id,
    count(*)::integer as source_count,
    min(source) as only_source
  from chain_cursors
  group by network_id, contract_id
)
update chain_event_failures f
set source = case when s.source_count = 1 then s.only_source else null end
from source_counts s
where s.network_id = f.network_id
  and s.contract_id = f.contract_id;
