-- Bound cart lookups and enforce one unfinished order per resident/item.
create unique index business_orders_one_pending_item
  on business_orders(buyer_account,item_id) where status <> 'paid';
