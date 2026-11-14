create table business_items (
 id uuid primary key,
 business_id bigint not null references businesses(id),
 sku text not null check(sku ~ '^[a-z0-9_-]{3,40}$'),
 name text not null check(length(name) between 1 and 60),
 unit_price numeric(39,0) not null check(unit_price between 1 and 10000),
 on_hand integer not null default 0 check(on_hand between 0 and 1000000),
 reserved integer not null default 0 check(reserved>=0 and reserved<=on_hand),
 low_stock integer not null default 5 check(low_stock between 0 and 1000000),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 unique(business_id,sku)
);
create table business_orders (
 id uuid primary key,
 buyer_account text not null,
 business_id bigint not null references businesses(id),
 item_id uuid not null references business_items(id),
 item_name text not null,
 quantity int not null check(quantity between 1 and 1000),
 unit_price numeric(39,0) not null check(unit_price>0),
 total numeric(39,0) not null check(total between 1 and 10000 and total=unit_price*quantity),
 buyer_tag text not null check(buyer_tag ~ '^[0-9a-f]{32}$'),
 reference text not null unique,
 status text not null default 'reserved' check(status in ('reserved','confirming','paid')),
 tx_hash text,
 receipt_id text,
 event_index int,
 created_at timestamptz not null default now(),
 paid_at timestamptz,
 check(reference='order:'||id::text||':'||business_id::text||':'||total::text||':'||buyer_tag)
);
create index business_orders_buyer_idx on business_orders(buyer_account,created_at desc);
create index business_orders_business_idx on business_orders(business_id,created_at desc);
create unique index business_orders_receipt_idx on business_orders(receipt_id,event_index) where receipt_id is not null;
create table stock_movements (
 id bigserial primary key,
 item_id uuid not null references business_items(id),
 quantity int not null check(quantity<>0),
 kind text not null check(kind in ('opening','delivery','sale')),
 reference text not null check(length(reference) between 1 and 128),
 order_id uuid unique references business_orders(id),
 actor_account text not null,
 created_at timestamptz not null default now(),
 unique(item_id,reference),
 check((kind='sale' and quantity<0 and order_id is not null) or (kind in ('opening','delivery') and quantity>0 and order_id is null))
);
create index stock_movements_item_idx on stock_movements(item_id,id);
