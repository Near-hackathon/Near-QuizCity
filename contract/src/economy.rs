use super::*;

pub const DAILY_REWARD_CAP: u128 = 5_000;
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Escrow {
    pub id: String,
    pub owner: AccountId,
    pub source: String,
    pub beneficiary: Option<String>,
    pub purpose: String,
    #[serde(serialize_with = "serialize_qc")]
    pub funded: u128,
    #[serde(serialize_with = "serialize_qc")]
    pub remaining: u128,
}

// Exact reviewed pre-economy state layout. Collection handles retain their original prefixes.
#[derive(near_sdk::borsh::BorshDeserialize, near_sdk::borsh::BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct PreviousContract {
    operator: AccountId,
    pending_operator: Option<AccountId>,
    paused: bool,
    players: UnorderedMap<AccountId, Player>,
    wallets: UnorderedMap<String, u128>,
    properties: UnorderedMap<u64, Property>,
    property_by_coord: UnorderedMap<String, u64>,
    businesses: UnorderedMap<u64, Business>,
    business_by_property: UnorderedMap<u64, u64>,
    processed_references: UnorderedSet<String>,
    next_property_id: u64,
    next_business_id: u64,
    event_seq: u64,
    total_issued: u128,
    total_burned: u128,
    tx_count: u64,
}
fn uuid(id: &str) {
    require!(
        id.len() == 36
            && id.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
                }
            }),
        "invalid reservation ID"
    );
}
fn escrow_wallet(id: &str) -> String {
    format!("gov:escrow.{id}")
}
fn tag(value: &str) -> String {
    env::sha256(value.as_bytes())
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[near_bindgen]
impl Contract {
    /// Supports only the exact reviewed previous layout; never guesses at an older deployment.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_economy() -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "contract account only"
        );
        let old: PreviousContract =
            env::state_read().expect("unsupported previous contract layout");
        let nonce = storage_nonce();
        Self {
            operator: old.operator,
            pending_operator: old.pending_operator,
            paused: old.paused,
            players: old.players,
            wallets: old.wallets,
            properties: old.properties,
            property_by_coord: old.property_by_coord,
            businesses: old.businesses,
            business_by_property: old.business_by_property,
            processed_references: old.processed_references,
            next_property_id: old.next_property_id,
            next_business_id: old.next_business_id,
            event_seq: old.event_seq,
            total_issued: old.total_issued,
            total_burned: old.total_burned,
            tx_count: old.tx_count,
            escrows: UnorderedMap::new(collection_prefix(b"esc", nonce)),
            business_sale_prices: UnorderedMap::new(collection_prefix(b"sale", nonce)),
            reward_day: 0,
            reward_day_issued: 0,
            lease_offers: UnorderedMap::new(collection_prefix(b"lease-offer", nonce)),
            leases: UnorderedMap::new(collection_prefix(b"lease", nonce)),
            leased_businesses: UnorderedMap::new(collection_prefix(b"leased-business", nonce)),
        }
    }
    pub fn supports_city_economy(&self) -> bool {
        true
    }
    pub fn get_escrow(&self, id: String) -> Option<Escrow> {
        self.escrows.get(&id)
    }
    pub fn get_business_sale_price(&self, business_id: u64) -> U128 {
        U128(self.business_sale_prices.get(&business_id).unwrap_or(0))
    }
    pub fn get_reward_policy(&self) -> serde_json::Value {
        let day = env::block_timestamp() / 86_400_000_000_000;
        serde_json::json!({"daily_cap": U128(DAILY_REWARD_CAP), "issued_today": U128(if day == self.reward_day { self.reward_day_issued } else { 0 }), "day": day.to_string()})
    }
    fn assert_wallet_owner(&self, wallet: &str) {
        let actor = env::predecessor_account_id();
        if wallet == player_wallet(&actor) {
            require!(self.players.get(&actor).is_some(), "player not registered");
            return;
        }
        if let Some(id) = wallet
            .strip_prefix("biz:")
            .and_then(|s| s.parse::<u64>().ok())
        {
            require!(
                self.businesses.get(&id).is_some_and(|b| b.owner == actor),
                "business owner only"
            );
            return;
        }
        require!(
            wallet == "gov:council" && actor == self.operator,
            "wallet owner only"
        );
    }
    pub fn fund_escrow(
        &mut self,
        id: String,
        source_wallet: String,
        beneficiary_wallet: Option<String>,
        amount: U128,
        purpose: String,
    ) -> bool {
        self.assert_not_paused();
        uuid(&id);
        validate_wallet(&source_wallet);
        self.assert_wallet_owner(&source_wallet);
        require!(
            [
                "job",
                "prize",
                "supply",
                "admission",
                "rent",
                "upkeep",
                "public_contract"
            ]
            .contains(&purpose.as_str()),
            "invalid reservation purpose"
        );
        require!(
            amount.0 > 0 && amount.0 <= MAX_JOB_PAYMENT,
            "reservation amount outside limits"
        );
        if let Some(beneficiary) = &beneficiary_wallet {
            validate_wallet(beneficiary);
            require!(
                *beneficiary != source_wallet && self.wallets.get(beneficiary).is_some(),
                "invalid beneficiary"
            );
        }
        require!(
            self.escrows.get(&id).is_none(),
            "reservation already funded"
        );
        let wallet = escrow_wallet(&id);
        require!(
            self.wallets.get(&wallet).is_none(),
            "reservation wallet exists"
        );
        let balance = self
            .wallet_balance(&source_wallet)
            .checked_sub(amount.0)
            .expect("insufficient QC balance");
        let tx = self.next_tx_count();
        self.assert_event_capacity(1);
        let escrow = Escrow {
            id: id.clone(),
            owner: env::predecessor_account_id(),
            source: source_wallet.clone(),
            beneficiary: beneficiary_wallet,
            purpose,
            funded: amount.0,
            remaining: amount.0,
        };
        self.wallets.insert(&source_wallet, &balance);
        self.wallets.insert(&wallet, &amount.0);
        self.tx_count = tx;
        self.escrows.insert(&id, &escrow);
        self.emit("escrow_funded", Some(&source_wallet), Some(&wallet), amount.0, Some(&format!("fund:{id}")), &format!("escrow:{id}"), serde_json::json!({"escrow_id":id,"owner":escrow.owner,"purpose":escrow.purpose,"beneficiary":escrow.beneficiary}));
        true
    }
    pub fn settle_escrow(
        &mut self,
        id: String,
        recipient_wallet: String,
        amount: U128,
        refund: bool,
        reference: String,
    ) -> bool {
        self.assert_not_paused();
        validate_wallet(&recipient_wallet);
        validate_reference(&reference);
        let mut escrow = self.escrows.get(&id).expect("unknown reservation");
        let actor = env::predecessor_account_id();
        if refund {
            require!(
                actor == self.operator && recipient_wallet == escrow.source,
                "operator refund to source only"
            );
        } else {
            require!(
                actor == self.operator
                    || (actor == escrow.owner
                        && escrow.beneficiary.as_ref() == Some(&recipient_wallet)),
                "reservation settlement not authorised"
            );
            if let Some(beneficiary) = &escrow.beneficiary {
                require!(*beneficiary == recipient_wallet, "wrong beneficiary");
            }
        }
        require!(
            reference.starts_with(&format!("settle:{id}:")),
            "invalid settlement reference"
        );
        self.assert_reference_available(&reference);
        require!(
            amount.0 > 0 && amount.0 <= escrow.remaining,
            "reservation balance exceeded"
        );
        let remaining = escrow
            .remaining
            .checked_sub(amount.0)
            .expect("reservation underflow");
        self.assert_event_capacity(1);
        self.transfer_internal(&escrow_wallet(&id), &recipient_wallet, amount.0);
        escrow.remaining = remaining;
        self.escrows.insert(&id, &escrow);
        self.mark_reference(&reference);
        self.emit(
            if refund {
                "escrow_refunded"
            } else {
                "escrow_released"
            },
            Some(&escrow_wallet(&id)),
            Some(&recipient_wallet),
            amount.0,
            Some(&reference),
            &format!("escrow:{id}"),
            serde_json::json!({"escrow_id":id,"purpose":escrow.purpose}),
        );
        true
    }
    /// Cancellation is permanent, including when a user still has a signed order transaction.
    pub fn cancel_order(&mut self, reference: String) -> bool {
        let actor = env::predecessor_account_id();
        let parts: Vec<_> = reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "order" && parts[4] == tag(actor.as_str()),
            "wrong order payer"
        );
        uuid(parts[1]);
        validate_reference(&reference);
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.mark_reference(&reference);
        self.mark_reference(&format!("cancelled:{reference}"));
        self.emit(
            "order_cancelled",
            None,
            None,
            0,
            Some(&reference),
            &format!("order:{}", parts[1]),
            serde_json::json!({"buyer":actor}),
        );
        true
    }
    pub fn npc_purchase(
        &mut self,
        npc_wallet: String,
        business_id: u64,
        amount: U128,
        reference: String,
    ) -> bool {
        self.assert_operator();
        self.assert_not_paused();
        self.assert_business_operating_rights(business_id);
        validate_wallet(&npc_wallet);
        require!(npc_wallet.starts_with("npc:"), "NPC wallet required");
        require!(amount.0 > 0 && amount.0 <= 100, "NPC purchase exceeds cap");
        let parts: Vec<_> = reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "npc-order",
            "invalid NPC order"
        );
        uuid(parts[1]);
        require!(
            reference
                == format!(
                    "npc-order:{}:{business_id}:{}:{}",
                    parts[1],
                    amount.0,
                    tag(&npc_wallet)
                ),
            "NPC order mismatch"
        );
        self.assert_reference_available(&reference);
        let mut business = self.businesses.get(&business_id).expect("unknown business");
        let revenue = Self::add_checked(
            business.revenue_total,
            amount.0,
            "business revenue overflow",
        );
        self.assert_event_capacity(1);
        self.transfer_internal(&npc_wallet, &business.treasury, amount.0);
        business.revenue_total = revenue;
        self.businesses.insert(&business_id, &business);
        self.mark_reference(&reference);
        self.emit(
            "service_paid",
            Some(&npc_wallet),
            Some(&business.treasury),
            amount.0,
            Some(&reference),
            &format!("business:{business_id}"),
            serde_json::json!({"business_id":business_id}),
        );
        true
    }
    pub fn refund_order(
        &mut self,
        business_id: u64,
        buyer_wallet: String,
        amount: U128,
        order_reference: String,
    ) -> bool {
        let business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            env::predecessor_account_id() == business.owner
                || env::predecessor_account_id() == self.operator,
            "business owner only"
        );
        validate_wallet(&buyer_wallet);
        require!(
            amount.0 > 0 && amount.0 <= MAX_SERVICE_PAYMENT,
            "invalid refund amount"
        );
        let parts: Vec<_> = order_reference.split(':').collect();
        require!(
            parts.len() == 5 && ["order", "npc-order"].contains(&parts[0]),
            "invalid original order"
        );
        let payer = if parts[0] == "order" {
            buyer_wallet
                .strip_prefix("player:")
                .expect("player wallet required")
        } else {
            require!(buyer_wallet.starts_with("npc:"), "NPC wallet required");
            &buyer_wallet
        };
        require!(
            order_reference
                == format!(
                    "{}:{}:{business_id}:{}:{}",
                    parts[0],
                    parts[1],
                    amount.0,
                    tag(payer)
                ),
            "refund does not match original payment"
        );
        require!(
            self.processed_references.contains(&order_reference),
            "order payment not found"
        );
        require!(
            !self
                .processed_references
                .contains(&format!("cancelled:{order_reference}")),
            "order was cancelled"
        );
        let reference = format!("refund:{}", tag(&order_reference));
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.transfer_internal(&business.treasury, &buyer_wallet, amount.0);
        self.mark_reference(&reference);
        self.emit(
            "order_refunded",
            Some(&business.treasury),
            Some(&buyer_wallet),
            amount.0,
            Some(&reference),
            &format!("business:{business_id}"),
            serde_json::json!({"business_id":business_id,"order_reference":order_reference}),
        );
        true
    }
    /// A full ticket refund is bound to its original buyer, venue, fee and paid reference.
    pub fn refund_admission(
        &mut self,
        business_id: u64,
        buyer_wallet: String,
        amount: U128,
        payment_reference: String,
    ) -> bool {
        let business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            env::predecessor_account_id() == business.owner
                || env::predecessor_account_id() == self.operator,
            "business owner only"
        );
        validate_wallet(&buyer_wallet);
        require!(
            buyer_wallet.starts_with("player:"),
            "player wallet required"
        );
        require!(amount.0 > 0 && amount.0 <= 1000, "invalid ticket refund");
        let parts: Vec<_> = payment_reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "charge",
            "invalid ticket reference"
        );
        uuid(parts[1]);
        require!(
            payment_reference
                == format!(
                    "charge:{}:{}:{}:{}",
                    parts[1],
                    amount.0,
                    tag(&buyer_wallet),
                    tag(&business.treasury)
                ),
            "ticket refund mismatch"
        );
        require!(
            self.processed_references.contains(&payment_reference),
            "ticket payment not found"
        );
        require!(
            !self
                .processed_references
                .contains(&format!("cancelled:{payment_reference}")),
            "ticket was cancelled"
        );
        let reference = format!("refund-ticket:{}", tag(&payment_reference));
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.transfer_internal(&business.treasury, &buyer_wallet, amount.0);
        self.mark_reference(&reference);
        self.emit(
            "admission_refunded",
            Some(&business.treasury),
            Some(&buyer_wallet),
            amount.0,
            Some(&reference),
            &format!("business:{business_id}"),
            serde_json::json!({"business_id":business_id,"payment_reference":payment_reference}),
        );
        true
    }
    pub fn list_business(&mut self, business_id: u64, price: U128) -> bool {
        let business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            env::predecessor_account_id() == business.owner,
            "business owner only"
        );
        require!(price.0 <= MAX_PROPERTY_PRICE, "business price exceeds cap");
        self.assert_event_capacity(1);
        self.business_sale_prices.insert(&business_id, &price.0);
        self.emit("business_listed",None,None,0,Some(&self.next_admin_reference("business-list")),&format!("business:{business_id}"),serde_json::json!({"business_id":business_id,"listing_price":price,"owner":business.owner}));
        true
    }
    pub fn buy_business(
        &mut self,
        business_id: u64,
        expected_owner: AccountId,
        expected_price: U128,
    ) -> bool {
        let buyer = env::predecessor_account_id();
        let mut business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            self.players.get(&buyer).is_some() && buyer != business.owner,
            "registered different buyer required"
        );
        let price = self.business_sale_prices.get(&business_id).unwrap_or(0);
        require!(
            price > 0 && price == expected_price.0 && business.owner == expected_owner,
            "business listing changed"
        );
        self.assert_business_transfer_recipient(business_id, &buyer);
        let seller = business.owner.clone();
        self.assert_event_capacity(1);
        self.transfer_internal(&player_wallet(&buyer), &player_wallet(&seller), price);
        business.owner = buyer.clone();
        self.businesses.insert(&business_id, &business);
        self.business_sale_prices.remove(&business_id);
        self.emit("business_sold",Some(&player_wallet(&buyer)),Some(&player_wallet(&seller)),price,Some(&self.next_admin_reference("business-sale")),&format!("business:{business_id}"),serde_json::json!({"id":business_id,"business_id":business_id,"previous_owner":seller,"new_owner":buyer,"previous_owner_wallet":player_wallet(&seller),"new_owner_wallet":player_wallet(&buyer)}));
        true
    }
    pub fn pay_charge(
        &mut self,
        source_wallet: String,
        to_wallet: String,
        amount: U128,
        reference: String,
    ) -> bool {
        self.assert_wallet_owner(&source_wallet);
        validate_wallet(&to_wallet);
        validate_reference(&reference);
        require!(
            amount.0 > 0 && amount.0 <= MAX_JOB_PAYMENT,
            "charge outside limits"
        );
        let parts: Vec<_> = reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "charge",
            "invalid charge reference"
        );
        uuid(parts[1]);
        require!(
            reference
                == format!(
                    "charge:{}:{}:{}:{}",
                    parts[1],
                    amount.0,
                    tag(&source_wallet),
                    tag(&to_wallet)
                ),
            "charge payer, recipient or amount mismatch"
        );
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.transfer_internal(&source_wallet, &to_wallet, amount.0);
        self.mark_reference(&reference);
        self.emit(
            "charge_paid",
            Some(&source_wallet),
            Some(&to_wallet),
            amount.0,
            Some(&reference),
            &to_wallet,
            serde_json::json!({}),
        );
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{account, as_account, expect_panic, setup};
    fn legacy(c: Contract) -> PreviousContract {
        PreviousContract {
            operator: c.operator,
            pending_operator: c.pending_operator,
            paused: c.paused,
            players: c.players,
            wallets: c.wallets,
            properties: c.properties,
            property_by_coord: c.property_by_coord,
            businesses: c.businesses,
            business_by_property: c.business_by_property,
            processed_references: c.processed_references,
            next_property_id: c.next_property_id,
            next_business_id: c.next_business_id,
            event_seq: c.event_seq,
            total_issued: c.total_issued,
            total_burned: c.total_burned,
            tx_count: c.tx_count,
        }
    }
    #[test]
    fn exact_previous_layout_migrates_without_losing_state_or_prefixes() {
        let mut c = setup();
        as_account("alice.testnet");
        c.register_player("Alice".into());
        c.claim_starter();
        as_account("quizcity.testnet");
        c.create_wallet("npc:fund".into(), U128(90));
        c.pay_job(
            "npc:fund".into(),
            "player:alice.testnet".into(),
            U128(5),
            "job:before".into(),
        );
        as_account("alice.testnet");
        c.buy_property(1);
        c.create_business(1, "Legacy books".into());
        let property = serde_json::to_value(c.get_property(1)).unwrap();
        let business = serde_json::to_value(c.get_business(1)).unwrap();
        let stats = serde_json::to_value(c.get_stats()).unwrap();
        let balance = c.get_balance("player:alice.testnet".into()).0;
        env::state_write(&legacy(c));
        as_account("bob.testnet");
        expect_panic(|| {
            Contract::migrate_economy();
        });
        let mut context = near_sdk::test_utils::VMContextBuilder::new();
        context
            .current_account_id(account("quizcity.testnet"))
            .predecessor_account_id(account("quizcity.testnet"));
        near_sdk::testing_env!(context.build());
        let upgraded = Contract::migrate_economy();
        assert_eq!(serde_json::to_value(upgraded.get_stats()).unwrap(), stats);
        assert_eq!(
            upgraded.get_balance("player:alice.testnet".into()).0,
            balance
        );
        assert_eq!(
            serde_json::to_value(upgraded.get_property(1)).unwrap(),
            property
        );
        assert_eq!(
            serde_json::to_value(upgraded.get_business(1)).unwrap(),
            business
        );
        assert!(upgraded.is_reference_processed("job:before".into()));
        assert_eq!(
            upgraded
                .get_player(account("alice.testnet"))
                .unwrap()
                .username,
            "Alice"
        );
        env::state_write(&upgraded);
        expect_panic(|| {
            Contract::migrate_economy();
        });
    }
    #[test]
    fn daily_cap_resets_on_the_next_utc_day_without_ignoring_existing_references() {
        let mut c = setup();
        as_account("quizcity.testnet");
        c.create_wallet("npc:daily".into(), U128(0));
        for i in 0..5 {
            c.credit_reward("npc:daily".into(), U128(1000), format!("quiz:day0:{i}"));
        }
        let mut context = near_sdk::test_utils::VMContextBuilder::new();
        context
            .current_account_id(account("quizcity.testnet"))
            .predecessor_account_id(account("quizcity.testnet"))
            .block_timestamp(86_400_000_000_000);
        near_sdk::testing_env!(context.build());
        c.credit_reward("npc:daily".into(), U128(1), "quiz:day1".into());
        assert_eq!(c.reward_day_issued, 1);
        assert_eq!(c.wallet_balance("npc:daily"), 5001);
        expect_panic(|| {
            c.credit_reward("npc:daily".into(), U128(1), "quiz:day0:0".into());
        });
        assert_eq!(c.reward_day_issued, 1);
        expect_panic(|| {
            c.create_wallet(
                "gov:escrow.00000000-0000-4000-8000-000000000001".into(),
                U128(100),
            );
        });
    }
    #[test]
    fn reservation_money_is_locked_and_settled_or_refunded_exactly_once() {
        let mut c = setup();
        as_account("alice.testnet");
        c.register_player("Alice".into());
        c.claim_starter();
        as_account("bob.testnet");
        c.register_player("Bob".into());
        as_account("alice.testnet");
        let id = "00000000-0000-4000-8000-000000000001".to_string();
        c.fund_escrow(
            id.clone(),
            "player:alice.testnet".into(),
            Some("player:bob.testnet".into()),
            U128(100),
            "job".into(),
        );
        assert_eq!(c.wallet_balance("player:alice.testnet"), 400);
        let before = (c.tx_count, c.event_seq, c.total_issued);
        expect_panic(|| {
            c.fund_escrow(
                id.clone(),
                "player:alice.testnet".into(),
                None,
                U128(1),
                "job".into(),
            );
        });
        as_account("bob.testnet");
        expect_panic(|| {
            c.settle_escrow(
                id.clone(),
                "player:bob.testnet".into(),
                U128(100),
                false,
                format!("settle:{id}:bad"),
            );
        });
        assert_eq!((c.tx_count, c.event_seq, c.total_issued), before);
        as_account("alice.testnet");
        let reference = format!("settle:{id}:one");
        c.settle_escrow(
            id.clone(),
            "player:bob.testnet".into(),
            U128(40),
            false,
            reference.clone(),
        );
        expect_panic(|| {
            c.settle_escrow(
                id.clone(),
                "player:bob.testnet".into(),
                U128(40),
                false,
                reference,
            );
        });
        as_account("quizcity.testnet");
        c.settle_escrow(
            id.clone(),
            "player:alice.testnet".into(),
            U128(60),
            true,
            format!("settle:{id}:refund"),
        );
        assert_eq!(c.wallet_balance("player:alice.testnet"), 460);
        assert_eq!(c.wallet_balance("player:bob.testnet"), 40);
        assert_eq!(c.get_escrow(id).unwrap().remaining, 0);
    }
    #[test]
    fn daily_reward_limit_rejects_before_mutation() {
        let mut c = setup();
        as_account("quizcity.testnet");
        c.create_wallet("npc:prize".into(), U128(0));
        for i in 0..5 {
            c.credit_reward("npc:prize".into(), U128(1000), format!("quiz:{i}"));
        }
        let before = (
            c.wallet_balance("npc:prize"),
            c.tx_count,
            c.event_seq,
            c.total_issued,
            c.reward_day_issued,
        );
        expect_panic(|| {
            c.credit_reward("npc:prize".into(), U128(1), "quiz:extra".into());
        });
        assert_eq!(
            (
                c.wallet_balance("npc:prize"),
                c.tx_count,
                c.event_seq,
                c.total_issued,
                c.reward_day_issued
            ),
            before
        );
        assert!(!c.is_reference_processed("quiz:extra".into()));
    }
}

#[near_bindgen]
impl Contract {
    pub fn pay_rent(
        &mut self,
        property_id: u64,
        expected_owner: String,
        amount: U128,
        reference: String,
    ) -> bool {
        let property = self.properties.get(&property_id).expect("unknown property");
        let offer = self.lease_offers.get(&property_id).expect("no lease offer");
        let actor = env::predecessor_account_id();
        require!(
            property.owner == expected_owner && offer.landlord == property.owner,
            "landlord changed"
        );
        require!(
            offer.rent == amount.0 && amount.0 > 0,
            "lease price changed"
        );
        require!(
            property.owner != player_wallet(&actor),
            "cannot rent your own property"
        );
        let now = env::block_timestamp();
        require!(
            self.leases
                .get(&property_id)
                .is_none_or(|l| l.grace_ends_at <= now),
            "property already leased"
        );
        let ends = now
            .checked_add(
                offer
                    .days
                    .checked_mul(86_400_000_000_000)
                    .expect("lease duration overflow"),
            )
            .expect("lease expiry overflow");
        let grace = ends
            .checked_add(259_200_000_000_000)
            .expect("lease grace overflow");
        self.assert_event_capacity(2);
        self.pay_charge(
            player_wallet(&actor),
            expected_owner.clone(),
            amount,
            reference.clone(),
        );
        self.leases.insert(
            &property_id,
            &Lease {
                tenant: actor.clone(),
                landlord: expected_owner,
                ends_at: ends,
                grace_ends_at: grace,
            },
        );
        self.emit("lease_started",None,None,0,Some(&reference),&format!("property:{property_id}"),serde_json::json!({"property_id":property_id,"tenant":actor,"ends_at":ends.to_string(),"grace_ends_at":grace.to_string()}));
        true
    }
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    use crate::tests::{as_account, expect_panic, setup};
    fn shop() -> Contract {
        let mut c = setup();
        as_account("alice.testnet");
        c.register_player("Alice".into());
        c.claim_starter();
        c.buy_property(1);
        c.create_business(1, "Corner shop".into());
        as_account("bob.testnet");
        c.register_player("Bob".into());
        c.claim_starter();
        c
    }
    #[test]
    fn npc_purchase_refund_and_business_sale_preserve_money_and_title_boundaries() {
        let mut c = shop();
        as_account("quizcity.testnet");
        let id = "00000000-0000-4000-8000-000000000002";
        let reference = format!("npc-order:{id}:1:20:{}", tag("npc:professor-kofi"));
        let before = c.wallet_balance("npc:professor-kofi");
        c.npc_purchase("npc:professor-kofi".into(), 1, U128(20), reference.clone());
        assert_eq!(c.wallet_balance("biz:1"), 20);
        assert_eq!(c.wallet_balance("npc:professor-kofi"), before - 20);
        let state = (c.tx_count, c.event_seq, c.wallet_balance("biz:1"));
        expect_panic(|| {
            c.npc_purchase("npc:professor-kofi".into(), 1, U128(20), reference.clone());
        });
        assert_eq!((c.tx_count, c.event_seq, c.wallet_balance("biz:1")), state);
        as_account("bob.testnet");
        expect_panic(|| {
            c.refund_order(1, "npc:professor-kofi".into(), U128(20), reference.clone());
        });
        as_account("alice.testnet");
        c.refund_order(1, "npc:professor-kofi".into(), U128(20), reference.clone());
        assert_eq!(c.wallet_balance("npc:professor-kofi"), before);
        assert_eq!(c.get_business(1).unwrap().revenue_total, 20);
        expect_panic(|| {
            c.refund_order(1, "npc:professor-kofi".into(), U128(20), reference);
        });
        c.list_business(1, U128(50));
        as_account("bob.testnet");
        let buyer = c.wallet_balance("player:bob.testnet");
        let seller = c.wallet_balance("player:alice.testnet");
        expect_panic(|| {
            c.buy_business(1, "alice.testnet".parse().unwrap(), U128(49));
        });
        assert_eq!(c.wallet_balance("player:bob.testnet"), buyer);
        c.buy_business(1, "alice.testnet".parse().unwrap(), U128(50));
        assert_eq!(c.get_business(1).unwrap().owner.as_str(), "bob.testnet");
        assert_eq!(c.get_property(1).unwrap().owner, "player:alice.testnet");
        assert_eq!(c.wallet_balance("player:bob.testnet"), buyer - 50);
        assert_eq!(c.wallet_balance("player:alice.testnet"), seller + 50);
    }
    #[test]
    fn ticket_payment_and_refund_are_exact_and_cancellation_cannot_be_refunded() {
        let mut c = shop();
        let id = "00000000-0000-4000-8000-000000000091";
        let reference = format!(
            "charge:{id}:5:{}:{}",
            tag("player:bob.testnet"),
            tag("biz:1")
        );
        let before = c.wallet_balance("player:bob.testnet");
        c.pay_admission(1, U128(5), reference.clone());
        as_account("alice.testnet");
        let state = (c.tx_count, c.event_seq, c.wallet_balance("biz:1"));
        expect_panic(|| {
            c.refund_admission(1, "player:bob.testnet".into(), U128(6), reference.clone());
        });
        assert_eq!((c.tx_count, c.event_seq, c.wallet_balance("biz:1")), state);
        c.refund_admission(1, "player:bob.testnet".into(), U128(5), reference.clone());
        assert_eq!(c.wallet_balance("player:bob.testnet"), before);
        assert_eq!(c.get_business(1).unwrap().revenue_total, 5);
        expect_panic(|| {
            c.refund_admission(1, "player:bob.testnet".into(), U128(5), reference.clone());
        });
        as_account("bob.testnet");
        let cancelled = format!(
            "charge:00000000-0000-4000-8000-000000000092:5:{}:{}",
            tag("player:bob.testnet"),
            tag("biz:1")
        );
        c.cancel_charge(
            "player:bob.testnet".into(),
            "biz:1".into(),
            U128(5),
            cancelled.clone(),
        );
        expect_panic(|| {
            c.pay_admission(1, U128(5), cancelled.clone());
        });
        as_account("alice.testnet");
        expect_panic(|| {
            c.refund_admission(1, "player:bob.testnet".into(), U128(5), cancelled);
        });
        assert_eq!(c.wallet_balance("player:bob.testnet"), before);
    }
    #[test]
    fn permanent_cancellation_blocks_late_payment_and_fake_refund() {
        let mut c = shop();
        let id = "00000000-0000-4000-8000-000000000003";
        let reference = format!("order:{id}:1:20:{}", tag("bob.testnet"));
        c.cancel_order(reference.clone());
        let before = (
            c.wallet_balance("player:bob.testnet"),
            c.tx_count,
            c.event_seq,
        );
        expect_panic(|| {
            c.pay_order(1, U128(20), reference.clone());
        });
        as_account("alice.testnet");
        expect_panic(|| {
            c.refund_order(1, "player:bob.testnet".into(), U128(20), reference);
        });
        assert_eq!(
            (
                c.wallet_balance("player:bob.testnet"),
                c.tx_count,
                c.event_seq
            ),
            before
        );
    }
    #[test]
    fn funded_employment_cannot_be_withdrawn_and_job_payout_consumes_escrow() {
        let mut c = shop();
        as_account("alice.testnet");
        let id = "00000000-0000-4000-8000-000000000004".to_string();
        c.fund_escrow(
            id.clone(),
            "player:alice.testnet".into(),
            None,
            U128(50),
            "job".into(),
        );
        let balance = c.wallet_balance("player:alice.testnet");
        expect_panic(|| {
            c.settle_escrow(
                id.clone(),
                "player:alice.testnet".into(),
                U128(50),
                true,
                format!("settle:{id}:refund"),
            );
        });
        assert_eq!(c.wallet_balance("player:alice.testnet"), balance);
        as_account("quizcity.testnet");
        c.pay_job(
            escrow_wallet(&id),
            "player:bob.testnet".into(),
            U128(50),
            "job:funded-test".into(),
        );
        assert_eq!(c.get_escrow(id.clone()).unwrap().remaining, 0);
        expect_panic(|| {
            c.settle_escrow(
                id.clone(),
                "player:alice.testnet".into(),
                U128(50),
                true,
                format!("settle:{id}:refund"),
            );
        });
    }
    #[test]
    fn charge_references_bind_exact_parties_and_amount_before_any_write() {
        let mut c = shop();
        let id = "00000000-0000-4000-8000-000000000005";
        let from = "player:bob.testnet";
        let to = "gov:council";
        let reference = format!("charge:{id}:10:{}:{}", tag(from), tag(to));
        let before = (
            c.wallet_balance(from),
            c.wallet_balance(to),
            c.tx_count,
            c.event_seq,
        );
        expect_panic(|| {
            c.pay_charge(from.into(), to.into(), U128(11), reference.clone());
        });
        assert_eq!(
            (
                c.wallet_balance(from),
                c.wallet_balance(to),
                c.tx_count,
                c.event_seq
            ),
            before
        );
        c.pay_charge(from.into(), to.into(), U128(10), reference.clone());
        expect_panic(|| {
            c.pay_charge(from.into(), to.into(), U128(10), reference);
        });
    }
}

#[near_bindgen]
impl Contract {
    pub fn sponsor_quiz(
        &mut self,
        id: String,
        source_wallet: String,
        amount: U128,
        reference: String,
    ) -> bool {
        self.assert_wallet_owner(&source_wallet);
        self.assert_not_paused();
        let mut escrow = self.escrows.get(&id).expect("unknown prize reservation");
        require!(escrow.purpose == "prize", "not a prize pool");
        require!(
            amount.0 > 0 && amount.0 <= MAX_JOB_PAYMENT,
            "sponsorship outside limits"
        );
        validate_reference(&reference);
        self.assert_reference_available(&reference);
        let parts: Vec<_> = reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "sponsor" && parts[1] == id,
            "invalid sponsorship reference"
        );
        uuid(parts[2]);
        require!(
            reference
                == format!(
                    "sponsor:{id}:{}:{}:{}",
                    parts[2],
                    amount.0,
                    tag(&source_wallet)
                ),
            "sponsor payment mismatch"
        );
        let funded = Self::add_checked(escrow.funded, amount.0, "prize funding overflow");
        let remaining = Self::add_checked(escrow.remaining, amount.0, "prize balance overflow");
        self.assert_event_capacity(1);
        self.transfer_internal(&source_wallet, &escrow_wallet(&id), amount.0);
        escrow.funded = funded;
        escrow.remaining = remaining;
        self.escrows.insert(&id, &escrow);
        self.mark_reference(&reference);
        self.emit(
            "escrow_sponsored",
            Some(&source_wallet),
            Some(&escrow_wallet(&id)),
            amount.0,
            Some(&reference),
            &format!("escrow:{id}"),
            serde_json::json!({"escrow_id":id,"purpose":"prize"}),
        );
        true
    }
    pub fn cancel_charge(
        &mut self,
        source_wallet: String,
        to_wallet: String,
        amount: U128,
        reference: String,
    ) -> bool {
        self.assert_wallet_owner(&source_wallet);
        validate_wallet(&to_wallet);
        validate_reference(&reference);
        let parts: Vec<_> = reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "charge",
            "invalid charge reference"
        );
        uuid(parts[1]);
        require!(
            reference
                == format!(
                    "charge:{}:{}:{}:{}",
                    parts[1],
                    amount.0,
                    tag(&source_wallet),
                    tag(&to_wallet)
                ),
            "charge cancellation mismatch"
        );
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.mark_reference(&reference);
        self.mark_reference(&format!("cancelled:{reference}"));
        self.emit(
            "charge_cancelled",
            None,
            None,
            0,
            Some(&reference),
            &to_wallet,
            serde_json::json!({"source_wallet":source_wallet}),
        );
        true
    }
}

#[near_bindgen]
impl Contract {
    pub fn pay_business_tax(&mut self, business_id: u64, period: u64) -> bool {
        let business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            business.owner == env::predecessor_account_id(),
            "business owner only"
        );
        require!(
            period == env::block_timestamp() / 2_592_000_000_000_000,
            "tax period changed"
        );
        let reference = format!("tax:{business_id}:{period}");
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.transfer_internal(&business.treasury, "gov:council", 5);
        self.mark_reference(&reference);
        self.emit(
            "charge_paid",
            Some(&business.treasury),
            Some("gov:council"),
            5,
            Some(&reference),
            "gov:council",
            serde_json::json!({"business_id":business_id,"period":period.to_string()}),
        );
        true
    }
}

#[near(serializers = [borsh,json])]
#[derive(Clone)]
pub struct LeaseOffer {
    pub landlord: String,
    #[serde(serialize_with = "serialize_qc")]
    pub rent: u128,
    pub days: u64,
}
#[near(serializers = [borsh,json])]
#[derive(Clone)]
pub struct Lease {
    pub tenant: AccountId,
    pub landlord: String,
    #[serde(serialize_with = "serialize_timestamp")]
    pub ends_at: u64,
    #[serde(serialize_with = "serialize_timestamp")]
    pub grace_ends_at: u64,
}
#[near_bindgen]
impl Contract {
    pub fn list_lease(&mut self, property_id: u64, rent: U128, period_days: u64) -> bool {
        let property = self.properties.get(&property_id).expect("unknown property");
        require!(
            property.owner == player_wallet(&env::predecessor_account_id()),
            "property owner only"
        );
        require!(
            rent.0 <= MAX_JOB_PAYMENT && [7, 30].contains(&period_days),
            "invalid lease terms"
        );
        self.assert_event_capacity(1);
        self.lease_offers.insert(
            &property_id,
            &LeaseOffer {
                landlord: property.owner.clone(),
                rent: rent.0,
                days: period_days,
            },
        );
        self.emit("lease_offered",None,None,0,Some(&self.next_admin_reference("lease-offer")),&format!("property:{property_id}"),serde_json::json!({"property_id":property_id,"owner_wallet":property.owner,"rent":rent,"period_days":period_days}));
        true
    }
    pub fn get_lease_offer(&self, property_id: u64) -> Option<LeaseOffer> {
        self.lease_offers.get(&property_id)
    }
    pub fn get_lease(&self, property_id: u64) -> Option<Lease> {
        self.leases.get(&property_id)
    }
}

impl Contract {
    pub(crate) fn assert_business_operating_rights(&self, business_id: u64) {
        if let Some(property_id) = self.leased_businesses.get(&business_id) {
            let business = self.businesses.get(&business_id).expect("unknown business");
            let property = self.properties.get(&property_id).expect("unknown property");
            require!(
                property.owner == player_wallet(&business.owner)
                    || self
                        .leases
                        .get(&property_id)
                        .is_some_and(|l| l.tenant == business.owner
                            && env::block_timestamp() < l.grace_ends_at),
                "business lease expired; renew or settle with the landlord"
            );
        }
    }
}

fn serialize_timestamp<S: near_sdk::serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

impl Contract {
    pub(crate) fn assert_business_transfer_recipient(&self, business_id: u64, buyer: &AccountId) {
        if let Some(id) = self.leased_businesses.get(&business_id) {
            let p = self.properties.get(&id).expect("unknown leased property");
            require!(
                p.owner == player_wallet(buyer)
                    || self.leases.get(&id).is_some_and(
                        |l| l.tenant == *buyer && env::block_timestamp() < l.grace_ends_at
                    ),
                "lease must authorise the new business owner"
            );
        }
    }
}

#[cfg(test)]
mod lease_tests {
    use super::*;
    use crate::tests::{account, as_account, expect_panic, setup};
    #[test]
    fn rent_grants_use_without_title_and_expiry_keeps_assets_and_treasury() {
        let mut c = setup();
        as_account("alice.testnet");
        c.register_player("Alice".into());
        c.claim_starter();
        c.buy_property(1);
        c.list_lease(1, U128(30), 7);
        as_account("bob.testnet");
        c.register_player("Bob".into());
        c.claim_starter();
        let id = "00000000-0000-4000-8000-000000000009";
        let reference = format!(
            "charge:{id}:30:{}:{}",
            tag("player:bob.testnet"),
            tag("player:alice.testnet")
        );
        c.pay_rent(
            1,
            "player:alice.testnet".into(),
            U128(30),
            reference.clone(),
        );
        assert_eq!(c.get_property(1).unwrap().owner, "player:alice.testnet");
        c.create_business(1, "Rented reading room".into());
        let before = c.wallet_balance("player:bob.testnet");
        expect_panic(|| {
            c.pay_rent(1, "player:alice.testnet".into(), U128(30), reference);
        });
        assert_eq!(c.wallet_balance("player:bob.testnet"), before);
        let context = near_sdk::test_utils::VMContextBuilder::new()
            .current_account_id(account("quizcity.testnet"))
            .predecessor_account_id(account("alice.testnet"))
            .block_timestamp(11 * 86_400_000_000_000)
            .build();
        near_sdk::testing_env!(context);
        let state = (
            c.tx_count,
            c.event_seq,
            c.wallet_balance("player:alice.testnet"),
        );
        expect_panic(|| {
            c.pay_service(1, U128(1));
        });
        assert_eq!(
            (
                c.tx_count,
                c.event_seq,
                c.wallet_balance("player:alice.testnet")
            ),
            state
        );
        assert!(c.get_business(1).is_some());
        assert!(c.get_property(1).is_some());
    }
}

#[near_bindgen]
impl Contract {
    pub fn pay_admission(&mut self, business_id: u64, amount: U128, reference: String) -> bool {
        self.assert_business_operating_rights(business_id);
        let actor = env::predecessor_account_id();
        require!(self.players.get(&actor).is_some(), "player not registered");
        require!(
            amount.0 > 0 && amount.0 <= 1000,
            "admission fee exceeds cap"
        );
        let mut business = self.businesses.get(&business_id).expect("unknown venue");
        let from = player_wallet(&actor);
        let to = business.treasury.clone();
        let parts: Vec<_> = reference.split(':').collect();
        require!(
            parts.len() == 5 && parts[0] == "charge",
            "invalid admission reference"
        );
        uuid(parts[1]);
        require!(
            reference
                == format!(
                    "charge:{}:{}:{}:{}",
                    parts[1],
                    amount.0,
                    tag(&from),
                    tag(&to)
                ),
            "admission payment mismatch"
        );
        let revenue = Self::add_checked(
            business.revenue_total,
            amount.0,
            "business revenue overflow",
        );
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.transfer_internal(&from, &to, amount.0);
        business.revenue_total = revenue;
        self.businesses.insert(&business_id, &business);
        self.mark_reference(&reference);
        self.emit(
            "service_paid",
            Some(&from),
            Some(&to),
            amount.0,
            Some(&reference),
            &format!("business:{business_id}"),
            serde_json::json!({"business_id":business_id}),
        );
        true
    }
}
