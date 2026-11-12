use near_sdk::collections::UnorderedMap;
use near_sdk::json_types::U128;
use near_sdk::{env, near, near_bindgen, require, AccountId, PanicOnDefault};

pub const STARTER_ALLOWANCE: u128 = 500;
pub const BUSINESS_PERMIT_FEE: u128 = 100;
pub const MAX_REWARD_PER_CALL: u128 = 1_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Player {
    pub username: String,
    pub created_at: u64,
    pub starter_claimed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Property {
    pub id: u64,
    pub kind: String,
    pub district: String,
    pub x: i32,
    pub y: i32,
    pub owner: String,
    pub price: u128,
    pub for_sale: bool,
    pub transfer_count: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Business {
    pub id: u64,
    pub name: String,
    pub owner: AccountId,
    pub property_id: u64,
    pub treasury: String,
    pub revenue_total: u128,
}

#[near(serializers = [json])]
pub struct CityStats {
    pub players: u64,
    pub properties: u64,
    pub businesses: u64,
    pub total_issued: U128,
    pub total_burned: U128,
    pub tx_count: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    operator: AccountId,
    players: UnorderedMap<AccountId, Player>,
    wallets: UnorderedMap<String, u128>,
    properties: UnorderedMap<u64, Property>,
    businesses: UnorderedMap<u64, Business>,
    business_by_property: UnorderedMap<u64, u64>,
    next_property_id: u64,
    next_business_id: u64,
    total_issued: u128,
    total_burned: u128,
    tx_count: u64,
}

fn player_wallet(account: &AccountId) -> String {
    format!("player:{}", account)
}

fn emit(event: &str, data: serde_json::Value) {
    let payload = serde_json::json!({
        "standard": "quizcity",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

#[near_bindgen]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
            operator: env::predecessor_account_id(),
            players: UnorderedMap::new(b"pl".to_vec()),
            wallets: UnorderedMap::new(b"wa".to_vec()),
            properties: UnorderedMap::new(b"pr".to_vec()),
            businesses: UnorderedMap::new(b"bu".to_vec()),
            business_by_property: UnorderedMap::new(b"bp".to_vec()),
            next_property_id: 1,
            next_business_id: 1,
            total_issued: 0,
            total_burned: 0,
            tx_count: 0,
        }
    }

    fn assert_operator(&self) {
        require!(
            env::predecessor_account_id() == self.operator,
            "only the city operator may call this"
        );
    }

    fn wallet_balance(&self, wallet: &str) -> u128 {
        self.wallets.get(&wallet.to_string()).unwrap_or(0)
    }

    fn credit(&mut self, wallet: &str, amount: u128) {
        let balance = self.wallet_balance(wallet);
        self.wallets
            .insert(&wallet.to_string(), &(balance + amount));
    }

    fn debit(&mut self, wallet: &str, amount: u128) {
        let balance = self.wallet_balance(wallet);
        require!(balance >= amount, "insufficient QC balance");
        self.wallets
            .insert(&wallet.to_string(), &(balance - amount));
    }

    fn transfer_internal(&mut self, from: &str, to: &str, amount: u128, kind: &str) {
        require!(amount > 0, "amount must be positive");
        require!(from != to, "cannot transfer to the same wallet");
        require!(
            self.wallets.get(&to.to_string()).is_some(),
            "unknown recipient wallet"
        );
        self.debit(from, amount);
        self.credit(to, amount);
        self.tx_count += 1;
        emit(
            "transfer",
            serde_json::json!({
                "from": from,
                "to": to,
                "amount": U128(amount),
                "kind": kind,
                "tx": self.tx_count,
            }),
        );
    }

    pub fn register_player(&mut self, username: String) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_none(),
            "player already registered"
        );
        require!(!username.trim().is_empty(), "username required");
        require!(username.len() <= 32, "username too long");
        let wallet = player_wallet(&account);
        if self.wallets.get(&wallet).is_none() {
            self.wallets.insert(&wallet, &0u128);
        }
        self.players.insert(
            &account,
            &Player {
                username,
                created_at: env::block_timestamp(),
                starter_claimed: false,
            },
        );
        emit(
            "player_registered",
            serde_json::json!({ "account": account }),
        );
        true
    }

    pub fn claim_starter(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let mut player = self.players.get(&account).expect("player not registered");
        require!(!player.starter_claimed, "starter allowance already claimed");
        player.starter_claimed = true;
        self.players.insert(&account, &player);
        let wallet = player_wallet(&account);
        self.credit(&wallet, STARTER_ALLOWANCE);
        self.total_issued += STARTER_ALLOWANCE;
        emit(
            "starter_allowance",
            serde_json::json!({ "wallet": wallet, "amount": U128(STARTER_ALLOWANCE) }),
        );
        U128(self.wallet_balance(&wallet))
    }

    pub fn transfer_qc(&mut self, to_wallet: String, amount: U128) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_some(),
            "player not registered"
        );
        let from = player_wallet(&account);
        self.transfer_internal(&from, &to_wallet, amount.0, "player_transfer");
        true
    }

    pub fn credit_reward(&mut self, wallet: String, amount: U128, reference: String) -> bool {
        self.assert_operator();
        require!(amount.0 > 0, "amount must be positive");
        require!(
            amount.0 <= MAX_REWARD_PER_CALL,
            "reward exceeds per-call cap"
        );
        require!(!reference.trim().is_empty(), "reference required");
        require!(self.wallets.get(&wallet).is_some(), "unknown reward wallet");
        self.credit(&wallet, amount.0);
        self.total_issued += amount.0;
        self.tx_count += 1;
        emit(
            "reward",
            serde_json::json!({
                "wallet": wallet,
                "amount": U128(amount.0),
                "reference": reference,
                "tx": self.tx_count,
            }),
        );
        true
    }

    pub fn create_wallet(&mut self, wallet: String, initial_balance: U128) -> bool {
        self.assert_operator();
        require!(!wallet.trim().is_empty(), "wallet id required");
        require!(self.wallets.get(&wallet).is_none(), "wallet already exists");
        self.wallets.insert(&wallet, &initial_balance.0);
        self.total_issued += initial_balance.0;
        emit(
            "wallet_created",
            serde_json::json!({ "wallet": wallet, "amount": U128(initial_balance.0) }),
        );
        true
    }

    pub fn create_property(
        &mut self,
        kind: String,
        district: String,
        x: i32,
        y: i32,
        owner_wallet: String,
        price: U128,
    ) -> u64 {
        self.assert_operator();
        require!(
            self.wallets.get(&owner_wallet).is_some(),
            "unknown owner wallet"
        );
        let id = self.next_property_id;
        self.next_property_id += 1;
        let for_sale = price.0 > 0;
        self.properties.insert(
            &id,
            &Property {
                id,
                kind,
                district,
                x,
                y,
                owner: owner_wallet.clone(),
                price: price.0,
                for_sale,
                transfer_count: 0,
            },
        );
        emit(
            "property_created",
            serde_json::json!({ "id": id, "owner": owner_wallet, "price": U128(price.0) }),
        );
        id
    }

    pub fn list_property(&mut self, property_id: u64, price: U128) -> bool {
        let mut property = self.properties.get(&property_id).expect("unknown property");
        let account = env::predecessor_account_id();
        require!(
            account == self.operator || property.owner == player_wallet(&account),
            "only the owner or operator may list this property"
        );
        require!(price.0 > 0, "price must be positive");
        property.price = price.0;
        property.for_sale = true;
        self.properties.insert(&property_id, &property);
        emit(
            "property_listed",
            serde_json::json!({ "id": property_id, "price": U128(price.0) }),
        );
        true
    }

    pub fn buy_property(&mut self, property_id: u64) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_some(),
            "player not registered"
        );
        let buyer = player_wallet(&account);
        let mut property = self.properties.get(&property_id).expect("unknown property");
        require!(property.for_sale, "property is not for sale");
        require!(property.owner != buyer, "you already own this property");
        let price = property.price;
        let seller = property.owner.clone();
        self.transfer_internal(&buyer, &seller, price, "property_sale");
        property.owner = buyer.clone();
        property.price = 0;
        property.for_sale = false;
        property.transfer_count += 1;
        self.properties.insert(&property_id, &property);
        emit(
            "property_transferred",
            serde_json::json!({
                "id": property_id,
                "from": seller,
                "to": buyer,
                "price": U128(price),
            }),
        );
        true
    }

    pub fn create_business(&mut self, property_id: u64, name: String) -> u64 {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_some(),
            "player not registered"
        );
        let property = self.properties.get(&property_id).expect("unknown property");
        require!(
            property.owner == player_wallet(&account),
            "you must own the property to open a business"
        );
        require!(
            self.business_by_property.get(&property_id).is_none(),
            "property already has a business"
        );
        require!(!name.trim().is_empty(), "business name required");

        let buyer_wallet = player_wallet(&account);
        self.debit(&buyer_wallet, BUSINESS_PERMIT_FEE);
        self.total_burned += BUSINESS_PERMIT_FEE;

        let id = self.next_business_id;
        self.next_business_id += 1;
        let treasury = format!("biz:{}", id);
        self.wallets.insert(&treasury, &0u128);
        self.businesses.insert(
            &id,
            &Business {
                id,
                name,
                owner: account.clone(),
                property_id,
                treasury: treasury.clone(),
                revenue_total: 0,
            },
        );
        self.business_by_property.insert(&property_id, &id);
        emit(
            "business_created",
            serde_json::json!({ "id": id, "owner": account, "treasury": treasury, "permit_fee": U128(BUSINESS_PERMIT_FEE) }),
        );
        id
    }

    pub fn pay_service(&mut self, business_id: u64, amount: U128) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_some(),
            "player not registered"
        );
        let mut business = self.businesses.get(&business_id).expect("unknown business");
        let from = player_wallet(&account);
        self.transfer_internal(&from, &business.treasury, amount.0, "service_payment");
        business.revenue_total += amount.0;
        self.businesses.insert(&business_id, &business);
        emit(
            "service_paid",
            serde_json::json!({ "business_id": business_id, "from": from, "amount": U128(amount.0) }),
        );
        true
    }

    pub fn business_withdraw(&mut self, business_id: u64, amount: U128) -> bool {
        let account = env::predecessor_account_id();
        let business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            business.owner == account,
            "only the business owner may withdraw"
        );
        let owner_wallet = player_wallet(&account);
        let treasury = business.treasury.clone();
        self.transfer_internal(&treasury, &owner_wallet, amount.0, "business_withdrawal");
        true
    }

    pub fn transfer_business(&mut self, business_id: u64, new_owner: AccountId) -> bool {
        let account = env::predecessor_account_id();
        let mut business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            business.owner == account,
            "only the business owner may transfer"
        );
        require!(
            self.players.get(&new_owner).is_some(),
            "new owner is not a registered player"
        );
        require!(
            new_owner != account,
            "business already owned by this player"
        );
        let previous = business.owner.clone();
        business.owner = new_owner.clone();
        self.businesses.insert(&business_id, &business);
        emit(
            "business_transferred",
            serde_json::json!({ "id": business_id, "from": previous, "to": new_owner }),
        );
        true
    }

    /// Pays a verified job from an NPC/business wallet. Operator-only, no minting.
    pub fn pay_job(
        &mut self,
        employer_wallet: String,
        employee_wallet: String,
        amount: U128,
        reference: String,
    ) -> bool {
        self.assert_operator();
        require!(amount.0 > 0, "amount must be positive");
        require!(!reference.trim().is_empty(), "reference required");
        require!(
            self.wallets.get(&employer_wallet).is_some(),
            "unknown employer wallet"
        );
        require!(
            self.wallets.get(&employee_wallet).is_some(),
            "unknown employee wallet"
        );
        self.transfer_internal(&employer_wallet, &employee_wallet, amount.0, "job_reward");
        emit(
            "job_reward",
            serde_json::json!({
                "from": employer_wallet,
                "to": employee_wallet,
                "amount": U128(amount.0),
                "reference": reference,
            }),
        );
        true
    }

    /// Testnet-only demo helper: wipes game state so the demo can be re-recorded.
    pub fn reset_demo(&mut self) {
        self.assert_operator();
        self.players.clear();
        self.wallets.clear();
        self.properties.clear();
        self.businesses.clear();
        self.business_by_property.clear();
        self.next_property_id = 1;
        self.next_business_id = 1;
        self.total_issued = 0;
        self.total_burned = 0;
        self.tx_count = 0;
        emit("demo_reset", serde_json::json!({}));
    }

    pub fn get_balance(&self, wallet: String) -> U128 {
        U128(self.wallet_balance(&wallet))
    }

    pub fn get_player_wallet(&self, account: AccountId) -> String {
        player_wallet(&account)
    }

    pub fn get_player(&self, account: AccountId) -> Option<Player> {
        self.players.get(&account)
    }

    pub fn get_property(&self, property_id: u64) -> Option<Property> {
        self.properties.get(&property_id)
    }

    pub fn get_properties(&self) -> Vec<Property> {
        self.properties.iter().map(|(_, value)| value).collect()
    }

    pub fn get_business(&self, business_id: u64) -> Option<Business> {
        self.businesses.get(&business_id)
    }

    pub fn get_businesses(&self) -> Vec<Business> {
        self.businesses.iter().map(|(_, value)| value).collect()
    }

    pub fn get_stats(&self) -> CityStats {
        CityStats {
            players: self.players.len(),
            properties: self.properties.len(),
            businesses: self.businesses.len(),
            total_issued: U128(self.total_issued),
            total_burned: U128(self.total_burned),
            tx_count: self.tx_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use std::str::FromStr;

    fn account(name: &str) -> AccountId {
        AccountId::from_str(name).unwrap()
    }

    fn as_account(name: &str) {
        let context = VMContextBuilder::new()
            .current_account_id(account("quizcity.testnet"))
            .predecessor_account_id(account(name))
            .build();
        testing_env!(context);
    }

    fn setup() -> Contract {
        as_account("quizcity.testnet");
        let mut contract = Contract::new();
        contract.create_wallet("npc:professor-kofi".to_string(), U128(1_000));
        contract.create_wallet("gov:council".to_string(), U128(0));
        contract.create_property(
            "plot".to_string(),
            "knowledge".to_string(),
            4,
            7,
            "npc:professor-kofi".to_string(),
            U128(300),
        );
        contract
    }

    #[test]
    fn register_then_claim_starter_once() {
        as_account("quizcity.testnet");
        let mut contract = Contract::new();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            500
        );
    }

    #[test]
    #[should_panic(expected = "starter allowance already claimed")]
    fn starter_cannot_be_claimed_twice() {
        as_account("quizcity.testnet");
        let mut contract = Contract::new();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.claim_starter();
    }

    #[test]
    #[should_panic(expected = "insufficient QC balance")]
    fn transfer_beyond_balance_panics() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.transfer_qc("npc:professor-kofi".to_string(), U128(10_000));
    }

    #[test]
    fn buy_property_moves_qc_and_ownership_atomically() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.buy_property(1);

        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            200
        );
        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            1_300
        );
        let property = contract.get_property(1).unwrap();
        assert_eq!(property.owner, "player:alice.testnet");
        assert!(!property.for_sale);
        assert_eq!(property.transfer_count, 1);
    }

    #[test]
    #[should_panic(expected = "you already own this property")]
    fn cannot_buy_own_property() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.buy_property(1);
        as_account("quizcity.testnet");
        contract.list_property(1, U128(400));
        as_account("alice.testnet");
        contract.buy_property(1);
    }

    #[test]
    fn full_business_loop_and_transfer() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.buy_property(1);
        let business_id = contract.create_business(1, "Central Quiz Centre".to_string());
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            100
        );
        assert_eq!(contract.get_stats().total_burned.0, 100);

        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        contract.pay_service(business_id, U128(20));
        assert_eq!(contract.get_balance("biz:1".to_string()).0, 20);

        as_account("alice.testnet");
        contract.business_withdraw(business_id, U128(20));
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            120
        );
        assert_eq!(contract.get_balance("biz:1".to_string()).0, 0);

        contract.transfer_business(business_id, account("bob.testnet"));
        assert_eq!(
            contract.get_business(business_id).unwrap().owner,
            account("bob.testnet")
        );
    }

    #[test]
    #[should_panic(expected = "only the business owner may withdraw")]
    fn non_owner_cannot_withdraw_business_funds() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.buy_property(1);
        let business_id = contract.create_business(1, "Central Quiz Centre".to_string());
        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        contract.pay_service(business_id, U128(20));
        contract.business_withdraw(business_id, U128(20));
    }

    #[test]
    #[should_panic(expected = "only the city operator may call this")]
    fn reward_requires_operator() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(100),
            "job-1".to_string(),
        );
    }

    #[test]
    fn pay_job_moves_npc_budget_to_worker() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(100),
            "job-1".to_string(),
        );
        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            900
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            600
        );
        assert_eq!(contract.get_stats().total_issued.0, 1_500);
    }

    #[test]
    #[should_panic(expected = "insufficient QC balance")]
    fn pay_job_cannot_exceed_npc_budget() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(5_000),
            "job-overspend".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "only the city operator may call this")]
    fn pay_job_requires_operator() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(100),
            "job-1".to_string(),
        );
    }

    #[test]
    fn reset_demo_wipes_state() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.reset_demo();
        let stats = contract.get_stats();
        assert_eq!(stats.players, 0);
        assert_eq!(stats.properties, 0);
        assert_eq!(stats.total_issued.0, 0);
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            0
        );
    }

    #[test]
    fn operator_reward_is_capped_and_tracked() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(100),
            "job-1".to_string(),
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            600
        );
        assert_eq!(contract.get_stats().total_issued.0, 1_600);
    }
}
