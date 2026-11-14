-- Preserve all previously quoted rooms; new rooms deduct exactly 2% from the stake.
alter table quiz_matches add column fee_policy text not null default 'added-5-v1';
alter table quiz_matches drop constraint quiz_matches_check;
alter table quiz_matches add constraint quiz_matches_fee_terms_check check (
 (fee_policy='added-5-v1' and venue_fee=ceil(stake*0.05))
 or
 (fee_policy='deducted-2-v2' and stake>=50 and mod(stake,50)=0 and venue_fee=stake/50 and gas_fee=0)
);
alter table quiz_matches alter column fee_policy set default 'deducted-2-v2';
