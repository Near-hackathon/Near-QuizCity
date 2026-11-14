-- Durable commands and product policies. Chain receipts remain the only payment proof.
create table city_operations (
 id uuid primary key,
 actor_account text not null,
 kind text not null check(kind in ('supplier','admission','job_fund','quiz_fund','rent','upkeep','budget','refund','cancel','settlement','charge')),
 method text not null,
 args jsonb not null check(jsonb_typeof(args)='object'),
 expected_events jsonb not null check(jsonb_typeof(expected_events)='array'),
 reference text not null unique check(length(reference) between 1 and 160),
 payload jsonb not null default '{}'::jsonb check(jsonb_typeof(payload)='object'),
 status text not null default 'awaiting' check(status in ('awaiting','unknown','confirmed','cancelled')),
 tx_hash text,
 receipt_id text,
 event_index integer,
 next_check_at timestamptz,
 check_count int not null default 0 check(check_count>=0),
 error_code text,
 created_at timestamptz not null default now(),
 confirmed_at timestamptz,
 unique(receipt_id,event_index)
);
create index city_operations_actor_idx on city_operations(actor_account,created_at desc,id);
create index city_operations_pending_idx on city_operations(next_check_at) where status in ('awaiting','unknown');
create table business_settings (
 business_id bigint primary key references businesses(id),
 open_minute int not null default 540 check(open_minute between 0 and 1439),
 close_minute int not null default 1260 check(close_minute between 1 and 1440),
 accepting_customers boolean not null default true,
 check(close_minute>open_minute)
);
create table supplier_offers (
 id text primary key check(length(id) between 1 and 60),
 name text not null check(length(name) between 1 and 60),
 wallet_id text not null,
 unit_price numeric(39,0) not null check(unit_price between 1 and 1000),
 on_hand int not null check(on_hand between 0 and 1000000),
 reserved int not null default 0 check(reserved between 0 and on_hand),
 active boolean not null default true
);
create table supplier_orders (
 operation_id uuid primary key references city_operations(id),
 offer_id text not null references supplier_offers(id),
 item_id uuid not null references business_items(id),
 quantity int not null check(quantity between 1 and 1000),
 unit_price numeric(39,0) not null check(unit_price>0),
 total numeric(39,0) not null check(total=quantity*unit_price and total between 1 and 10000),
 fulfilled_at timestamptz
);
create table funded_jobs (
 job_id text primary key,
 operation_id uuid not null unique references city_operations(id),
 business_id bigint references businesses(id),
 creator_account text not null,
 escrow_id uuid not null unique,
 title text not null check(length(title) between 3 and 100),
 description text not null check(length(description) between 20 and 2000),
 payment numeric(39,0) not null check(payment between 1 and 10000),
 deadline timestamptz not null,
 state text not null default 'funding' check(state in ('funding','active','disputed','cancelled','paid')),
 review_note text,
 created_at timestamptz not null default now()
);
create table business_staff (
 job_id text primary key references funded_jobs(job_id),
 business_id bigint not null references businesses(id),
 account_id text not null,
 started_at timestamptz not null default now(),
 ended_at timestamptz
);
create table property_rent_offers (
 property_id bigint primary key references properties(id),
 owner_wallet text not null,
 rent numeric(39,0) not null check(rent between 1 and 10000),
 period_days int not null check(period_days in (7,30)),
 active boolean not null default true
);
create table property_leases (
 id uuid primary key references city_operations(id),
 property_id bigint not null references properties(id),
 landlord_wallet text not null,
 tenant_account text not null,
 starts_at timestamptz,
 ends_at timestamptz,
 grace_ends_at timestamptz,
 status text not null default 'reserved' check(status in ('reserved','active','expired','cancelled')),
 check(ends_at is null or ends_at>starts_at)
);
create unique index property_one_lease_idx on property_leases(property_id) where status in ('reserved','active');
create table property_condition (
 property_id bigint primary key references properties(id),
 condition int not null default 100 check(condition between 0 and 100),
 last_maintained_at timestamptz not null default now(),
 repair_cost numeric(39,0) not null default 10 check(repair_cost between 1 and 10000)
);
create table quiz_drafts (
 id uuid primary key,
 author_account text not null,
 business_id bigint not null references businesses(id),
 title text not null check(length(title) between 3 and 100),
 questions jsonb not null check(jsonb_typeof(questions)='array' and jsonb_array_length(questions) between 1 and 20),
 pass_score int not null check(pass_score between 1 and 20),
 entry_fee numeric(39,0) not null check(entry_fee between 0 and 1000),
 reward numeric(39,0) not null check(reward between 0 and 1000),
 capacity int not null check(capacity between 1 and 100),
 opens_at timestamptz not null,
 closes_at timestamptz not null,
 status text not null default 'draft' check(status in ('draft','review','approved','rejected','published','suspended')),
 moderator_account text,
 moderation_note text,
 approved_at timestamptz,
 quiz_id text unique,
 escrow_id uuid unique,
 funding_operation_id uuid unique references city_operations(id),
 created_at timestamptz not null default now(),
 check(closes_at>opens_at),
 check(moderator_account is null or moderator_account<>author_account)
);
create table quiz_reports (
 id uuid primary key,
 draft_id uuid not null references quiz_drafts(id),
 reporter_account text not null,
 reason text not null check(length(reason) between 10 and 500),
 resolved_at timestamptz,
 resolution text,
 unique(draft_id,reporter_account)
);
create table quiz_admissions (
 operation_id uuid primary key references city_operations(id),
 quiz_id text not null references quizzes(id),
 player_account text not null,
 attempt_id text unique references quiz_attempts(id),
 paid_at timestamptz
);
create unique index quiz_one_unused_admission_idx on quiz_admissions(quiz_id,player_account) where attempt_id is null;
alter table quizzes add column creator_draft_id uuid unique references quiz_drafts(id);
alter table quiz_attempts add column funding_escrow_id uuid;
create table council_budgets (
 category text primary key check(category in ('library','employment','quizzes','maintenance','suppliers')),
 ceiling numeric(39,0) not null default 0 check(ceiling between 0 and 1000000),
 committed numeric(39,0) not null default 0 check(committed>=0),
 spent numeric(39,0) not null default 0 check(spent>=0),
 check(committed+spent<=ceiling)
);
insert into council_budgets(category) values ('library'),('employment'),('quizzes'),('maintenance'),('suppliers');
create table council_commitments (
 operation_id uuid primary key references city_operations(id),
 category text not null references council_budgets(category),
 amount numeric(39,0) not null check(amount between 1 and 10000),
 purpose text not null check(length(purpose) between 10 and 500),
 paid_at timestamptz
);
create table npc_shop_visits (
 id uuid primary key,
 npc_id text not null references npc_runtime(npc_id),
 business_id bigint not null references businesses(id),
 item_id uuid not null references business_items(id),
 quantity int not null default 1 check(quantity=1),
 amount numeric(39,0) not null check(amount between 1 and 100),
 reference text not null unique,
 day date not null,
 destination_scene_id text not null references scenes(id),
 destination_spawn_id text not null references spawn_points(id),
 status text not null default 'walking' check(status in ('walking','queued','submitting','unknown','paid','cancelled')),
 tx_hash text,
 receipt_id text,
 event_index int,
 queued_at timestamptz,
 paid_at timestamptz,
 created_at timestamptz not null default now(),
 unique(npc_id,day),
 unique(receipt_id,event_index)
);
create index npc_shop_active_idx on npc_shop_visits(npc_id) where status in ('walking','queued','submitting','unknown');
-- Publication freezes scoring content; revisions are new drafts.
create function freeze_reviewed_quiz() returns trigger language plpgsql as $$
begin
 if old.status in ('review','approved','published','suspended') and
 (new.title,new.questions,new.pass_score,new.entry_fee,new.reward,new.capacity,new.opens_at,new.closes_at,new.business_id) is distinct from
 (old.title,old.questions,old.pass_score,old.entry_fee,old.reward,old.capacity,old.opens_at,old.closes_at,old.business_id) then
 raise exception 'reviewed quiz content is immutable';
 end if;
 return new;
end $$;
create trigger quiz_content_frozen before update on quiz_drafts for each row execute function freeze_reviewed_quiz();
alter table business_orders drop constraint business_orders_status_check;
alter table business_orders add constraint business_orders_status_check check(status in ('reserved','confirming','paid','cancelled','refunded'));
drop index business_orders_one_pending_item;
create unique index business_orders_one_pending_item on business_orders(buyer_account,item_id) where status in ('reserved','confirming');
insert into supplier_offers(id,name,wallet_id,unit_price,on_hand) values ('city-supply','City Supply','gov:council',2,10000);
alter table stock_movements add column npc_visit_id uuid unique references npc_shop_visits(id);
alter table stock_movements drop constraint stock_movements_check;
alter table stock_movements add constraint stock_movements_source_check check(
 (kind='sale' and quantity<0 and ((order_id is not null and npc_visit_id is null) or (order_id is null and npc_visit_id is not null)))
 or (kind in ('opening','delivery') and quantity>0 and order_id is null and npc_visit_id is null)
);
update scenes set asset_version=6 where id='city-district';
insert into spawn_points(id,scene_id,kind,x,y) select 'market-queue','city-district','npc_waypoint',5,8 from scenes where id='city-district' on conflict(id) do update set x=5,y=8,active=true;
update player_presence set scene_version=6,path='[]'::jsonb,path_index=0,state_version=state_version+1 where scene_id='city-district';
create table item_price_history (
 id bigserial primary key,
 item_id uuid not null references business_items(id),
 old_price numeric(39,0) not null check(old_price>0),
 new_price numeric(39,0) not null check(new_price>0),
 changed_at timestamptz not null default now()
);
create index item_price_history_item_idx on item_price_history(item_id,id desc);
create function record_item_price() returns trigger language plpgsql as $$ begin
 if new.unit_price<>old.unit_price then insert into item_price_history(item_id,old_price,new_price) values (old.id,old.unit_price,new.unit_price); end if;
 return new; end $$;
create trigger item_price_changed after update of unit_price on business_items for each row execute function record_item_price();
create table business_tax_invoices (
 business_id bigint not null references businesses(id),
 period text not null,
 amount numeric(39,0) not null default 5 check(amount=5),
 operation_id uuid unique references city_operations(id),
 paid_at timestamptz,
 primary key(business_id,period)
);
create table inventory_returns (
 operation_id uuid primary key references city_operations(id),
 item_id uuid not null references business_items(id),
 quantity integer not null check(quantity>0),
 restocked integer not null check(restocked>=0),
 discarded integer not null check(discarded>=0),
 reason text not null default 'returned_goods',
 check(restocked+discarded=quantity)
);
alter table npc_shop_visits drop constraint npc_shop_visits_status_check;
alter table npc_shop_visits add constraint npc_shop_visits_status_check check(status in ('walking','queued','submitting','unknown','paid','cancelled','refunded'));

alter table quiz_admissions add column refunded_at timestamptz;
drop index if exists quiz_one_unused_admission_idx;
create unique index quiz_admission_available_idx on quiz_admissions(quiz_id,player_account) where attempt_id is null and refunded_at is null;
alter table quiz_admissions add column refund_operation_id uuid references city_operations(id);

alter table property_condition add column utilities_paid_until timestamptz not null default now()+interval '30 days';
insert into property_condition(property_id) select id from properties on conflict do nothing;

alter table property_condition add column utilities_active boolean not null default true;
