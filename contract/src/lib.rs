use near_sdk::collections::{UnorderedMap, UnorderedSet};
use near_sdk::json_types::U128;
use near_sdk::{env, near, near_bindgen, require, AccountId, PanicOnDefault};

/// QC is an integer unit with no decimals.
pub const STARTER_ALLOWANCE: u128 = 500;
pub const BUSINESS_PERMIT_FEE: u128 = 100;
pub const MAX_REWARD_PER_CALL: u128 = 1_000;
pub const MAX_JOB_PAYMENT: u128 = 10_000;
pub const MAX_SERVICE_PAYMENT: u128 = 10_000;
pub const MAX_PROPERTY_PRICE: u128 = 1_000_000;
pub const MAX_QC_TRANSFER: u128 = 1_000_000;
pub const MAX_INITIAL_BALANCE: u128 = 1_000_000;
pub const MAX_TOTAL_SUPPLY: u128 = 1_000_000_000;

pub const MAX_USERNAME_LEN: usize = 32;
pub const MAX_WALLET_LEN: usize = 96;
pub const MAX_DISTRICT_LEN: usize = 32;
pub const MAX_KIND_LEN: usize = 32;
pub const MAX_BUSINESS_NAME_LEN: usize = 48;
pub const MAX_REFERENCE_LEN: usize = 128;
pub const PAGE_LIMIT_MAX: u64 = 100;

const EVENT_STANDARD: &str = "quizcity";
const EVENT_VERSION: &str = "1.0.0";
const WALLET_PREFIXES: [&str; 4] = ["player:", "npc:", "gov:", "biz:"];

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
pub struct WalletBalance {
    pub wallet_id: String,
    pub balance: U128,
}

#[near(serializers = [json])]
pub struct CityStats {
    pub players: u64,
    pub properties: u64,
    pub businesses: u64,
    pub total_issued: U128,
    pub total_burned: U128,
    pub tx_count: u64,
    pub paused: bool,
    pub pending_operator: Option<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
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

fn player_wallet(account: &AccountId) -> String {
    format!("player:{}", account)
}

fn coord_key(district: &str, x: i32, y: i32) -> String {
    format!("{district}\u{1f}{x}\u{1f}{y}")
}

fn collection_prefix(tag: &[u8], nonce: u64) -> Vec<u8> {
    let mut prefix = tag.to_vec();
    prefix.extend_from_slice(&nonce.to_le_bytes());
    prefix
}

fn storage_nonce() -> u64 {
    env::block_timestamp() ^ (env::block_height() << 32)
}

fn validate_text(value: &str, field: &str, max_len: usize) {
    require!(!value.is_empty(), &format!("{} is required", field));
    require!(
        value.len() <= max_len,
        &format!("{} exceeds {} bytes", field, max_len)
    );
    require!(
        value.trim() == value,
        &format!("{} must not have leading or trailing whitespace", field)
    );
    require!(
        !value.chars().any(char::is_control),
        &format!("{} contains control characters", field)
    );
}

fn validate_wallet(wallet: &str) {
    validate_text(wallet, "wallet id", MAX_WALLET_LEN);
    let prefix = WALLET_PREFIXES
        .iter()
        .find(|prefix| wallet.starts_with(*prefix))
        .unwrap_or_else(|| env::panic_str("wallet prefix must be player:, npc:, gov:, or biz:"));
    let suffix = &wallet[prefix.len()..];
    require!(!suffix.is_empty(), "wallet suffix is required");
    require!(
        suffix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')),
        "wallet suffix may contain only lowercase letters, digits, '.', '_', and '-'"
    );
}

fn validate_reference(reference: &str) {
    validate_text(reference, "reference", MAX_REFERENCE_LEN);
}

#[near_bindgen]
impl Contract {
    fn initialized(operator: AccountId) -> Self {
        let nonce = storage_nonce();
        Self {
            operator,
            pending_operator: None,
            paused: false,
            players: UnorderedMap::new(collection_prefix(b"pl", nonce)),
            wallets: UnorderedMap::new(collection_prefix(b"wa", nonce)),
            properties: UnorderedMap::new(collection_prefix(b"pr", nonce)),
            property_by_coord: UnorderedMap::new(collection_prefix(b"pc", nonce)),
            businesses: UnorderedMap::new(collection_prefix(b"bu", nonce)),
            business_by_property: UnorderedMap::new(collection_prefix(b"bp", nonce)),
            processed_references: UnorderedSet::new(collection_prefix(b"rf", nonce)),
            next_property_id: 1,
            next_business_id: 1,
            event_seq: 0,
            total_issued: 0,
            total_burned: 0,
            tx_count: 0,
        }
    }

    #[init]
    pub fn new() -> Self {
        Self::initialized(env::predecessor_account_id())
    }

    /// Testnet demo-only state wipe. Built only with `--features demo-reset`.
    #[cfg(feature = "demo-reset")]
    #[private]
    #[init(ignore_state)]
    pub fn migrate_reset() -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "migrate_reset may only be called by the contract account"
        );
        Self::initialized(env::current_account_id())
    }

    fn assert_operator(&self) {
        require!(
            env::predecessor_account_id() == self.operator,
            "only the city operator may call this"
        );
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "operator payouts are paused");
    }

    fn wallet_balance(&self, wallet: &str) -> u128 {
        self.wallets.get(&wallet.to_string()).unwrap_or(0)
    }

    fn add_checked(a: u128, b: u128, message: &str) -> u128 {
        a.checked_add(b).unwrap_or_else(|| env::panic_str(message))
    }

    fn next_tx_count(&self) -> u64 {
        self.tx_count.checked_add(1).expect("tx counter overflow")
    }

    /// Fails before any state write when `additional_events` would overflow the
    /// event sequence. Demo reset is exempt because it starts a fresh sequence.
    fn assert_event_capacity(&self, additional_events: u64) {
        self.event_seq
            .checked_add(additional_events)
            .expect("event sequence overflow");
    }

    fn mint(&mut self, wallet: &str, amount: u128) {
        require!(amount > 0, "amount must be positive");
        let balance = self.wallet_balance(wallet);
        let new_balance = Self::add_checked(balance, amount, "wallet balance overflow");
        let new_total = Self::add_checked(self.total_issued, amount, "total supply overflow");
        require!(new_total <= MAX_TOTAL_SUPPLY, "total supply cap exceeded");
        let new_tx_count = self.next_tx_count();
        self.wallets.insert(&wallet.to_string(), &new_balance);
        self.total_issued = new_total;
        self.tx_count = new_tx_count;
    }

    fn burn(&mut self, wallet: &str, amount: u128) {
        require!(amount > 0, "amount must be positive");
        let balance = self.wallet_balance(wallet);
        require!(balance >= amount, "insufficient QC balance");
        let new_balance = balance.checked_sub(amount).expect("balance underflow");
        let new_burned = Self::add_checked(self.total_burned, amount, "burn counter overflow");
        let new_tx_count = self.next_tx_count();
        self.wallets.insert(&wallet.to_string(), &new_balance);
        self.total_burned = new_burned;
        self.tx_count = new_tx_count;
    }

    fn transfer_internal(&mut self, from: &str, to: &str, amount: u128) {
        require!(amount > 0, "amount must be positive");
        require!(amount <= MAX_QC_TRANSFER, "transfer exceeds per-call cap");
        require!(from != to, "cannot transfer to the same wallet");
        let from_balance = self.wallet_balance(from);
        require!(from_balance >= amount, "insufficient QC balance");
        let to_balance = self
            .wallets
            .get(&to.to_string())
            .expect("unknown recipient wallet");
        let new_from_balance = from_balance.checked_sub(amount).expect("balance underflow");
        let new_to_balance = Self::add_checked(to_balance, amount, "wallet balance overflow");
        let new_tx_count = self.next_tx_count();
        self.wallets.insert(&from.to_string(), &new_from_balance);
        self.wallets.insert(&to.to_string(), &new_to_balance);
        self.tx_count = new_tx_count;
    }

    fn assert_reference_available(&self, reference: &str) {
        require!(
            !self.processed_references.contains(&reference.to_string()),
            "reference already processed"
        );
    }

    fn mark_reference(&mut self, reference: &str) {
        self.processed_references.insert(&reference.to_string());
    }

    fn page_bounds(from_index: u64, limit: u64, total: u64) -> Option<(usize, usize)> {
        if limit == 0 || from_index >= total {
            return None;
        }
        let start = usize::try_from(from_index).ok()?;
        let limit = usize::try_from(limit.min(PAGE_LIMIT_MAX)).expect("page limit fits usize");
        Some((start, limit))
    }

    fn next_admin_reference(&self, action: &str) -> String {
        format!(
            "{action}:{}:{}",
            env::block_timestamp(),
            self.event_seq
                .checked_add(1)
                .expect("event sequence overflow")
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn emit(
        &mut self,
        event: &str,
        wallet_from: Option<&str>,
        wallet_to: Option<&str>,
        amount: u128,
        reference: Option<&str>,
        entity_id: &str,
        extra: serde_json::Value,
    ) {
        self.event_seq = self
            .event_seq
            .checked_add(1)
            .expect("event sequence overflow");
        let mut data = serde_json::json!({
            "seq": self.event_seq,
            "wallet_from": wallet_from,
            "wallet_to": wallet_to,
            "amount": U128(amount),
            "reference": reference,
            "entity_id": entity_id,
        });
        if let (Some(target), serde_json::Value::Object(extra)) = (data.as_object_mut(), extra) {
            for (key, value) in extra {
                target.insert(key, value);
            }
        }
        let payload = serde_json::json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
            "event": event,
            "data": [data],
        });
        env::log_str(&format!("EVENT_JSON:{}", payload));
    }

    pub fn register_player(&mut self, username: String) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_none(),
            "player already registered"
        );
        validate_text(&username, "username", MAX_USERNAME_LEN);
        self.assert_event_capacity(1);
        let wallet = player_wallet(&account);
        if self.wallets.get(&wallet).is_none() {
            self.wallets.insert(&wallet, &0u128);
        }
        self.players.insert(
            &account,
            &Player {
                username: username.clone(),
                created_at: env::block_timestamp(),
                starter_claimed: false,
            },
        );
        self.emit(
            "player_registered",
            None,
            None,
            0,
            Some(&format!("player:{}", account)),
            &wallet,
            serde_json::json!({ "account": account, "username": username, "owner_wallet": wallet }),
        );
        true
    }

    pub fn claim_starter(&mut self) -> U128 {
        let account = env::predecessor_account_id();
        let mut player = self.players.get(&account).expect("player not registered");
        require!(!player.starter_claimed, "starter allowance already claimed");
        let wallet = player_wallet(&account);
        self.assert_event_capacity(1);
        self.mint(&wallet, STARTER_ALLOWANCE);
        player.starter_claimed = true;
        self.players.insert(&account, &player);
        self.emit(
            "starter_allowance",
            None,
            Some(&wallet),
            STARTER_ALLOWANCE,
            Some(&format!("starter:{account}")),
            &wallet,
            serde_json::json!({ "account": account }),
        );
        U128(self.wallet_balance(&wallet))
    }

    pub fn transfer_qc(&mut self, to_wallet: String, amount: U128) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_some(),
            "player not registered"
        );
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= MAX_QC_TRANSFER, "transfer exceeds per-call cap");
        validate_wallet(&to_wallet);
        let from = player_wallet(&account);
        self.assert_event_capacity(1);
        self.transfer_internal(&from, &to_wallet, amount.0);
        self.emit(
            "wallet_transfer",
            Some(&from),
            Some(&to_wallet),
            amount.0,
            Some(&format!("transfer:{}", self.tx_count)),
            &to_wallet,
            serde_json::json!({ "kind": "player_transfer" }),
        );
        true
    }

    pub fn credit_reward(&mut self, wallet: String, amount: U128, reference: String) -> bool {
        self.assert_operator();
        self.assert_not_paused();
        validate_wallet(&wallet);
        validate_reference(&reference);
        require!(amount.0 > 0, "amount must be positive");
        require!(
            amount.0 <= MAX_REWARD_PER_CALL,
            "reward exceeds per-call cap"
        );
        require!(self.wallets.get(&wallet).is_some(), "unknown reward wallet");
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.mint(&wallet, amount.0);
        self.mark_reference(&reference);
        self.emit(
            "reward_issued",
            None,
            Some(&wallet),
            amount.0,
            Some(&reference),
            &wallet,
            serde_json::json!({}),
        );
        true
    }

    pub fn create_wallet(&mut self, wallet: String, initial_balance: U128) -> bool {
        self.assert_operator();
        validate_wallet(&wallet);
        require!(
            initial_balance.0 <= MAX_INITIAL_BALANCE,
            "initial balance exceeds cap"
        );
        require!(self.wallets.get(&wallet).is_none(), "wallet already exists");
        self.assert_event_capacity(1);
        if initial_balance.0 > 0 {
            self.mint(&wallet, initial_balance.0);
        } else {
            self.wallets.insert(&wallet, &0u128);
        }
        self.emit(
            "wallet_created",
            None,
            if initial_balance.0 > 0 {
                Some(&wallet)
            } else {
                None
            },
            initial_balance.0,
            Some(&format!("wallet:{wallet}")),
            &wallet,
            serde_json::json!({ "owner_wallet": wallet, "funded": initial_balance.0 > 0 }),
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
        validate_text(&kind, "property kind", MAX_KIND_LEN);
        validate_text(&district, "district", MAX_DISTRICT_LEN);
        validate_wallet(&owner_wallet);
        require!(
            self.wallets.get(&owner_wallet).is_some(),
            "unknown owner wallet"
        );
        require!(price.0 <= MAX_PROPERTY_PRICE, "property price exceeds cap");
        let key = coord_key(&district, x, y);
        require!(
            self.property_by_coord.get(&key).is_none(),
            "coordinate already occupied"
        );
        self.assert_event_capacity(1);
        let id = self.next_property_id;
        self.next_property_id = self
            .next_property_id
            .checked_add(1)
            .expect("property id overflow");
        let for_sale = price.0 > 0;
        self.properties.insert(
            &id,
            &Property {
                id,
                kind: kind.clone(),
                district: district.clone(),
                x,
                y,
                owner: owner_wallet.clone(),
                price: price.0,
                for_sale,
                transfer_count: 0,
            },
        );
        self.property_by_coord.insert(&key, &id);
        let reference = format!("property:create:{id}");
        self.emit(
            "property_created",
            None,
            None,
            0,
            Some(&reference),
            &format!("property:{id}"),
            serde_json::json!({
                "id": id,
                "kind": kind,
                "district": district,
                "x": x,
                "y": y,
                "owner_wallet": owner_wallet,
                "listing_price": U128(price.0),
                "for_sale": for_sale,
            }),
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
        require!(price.0 <= MAX_PROPERTY_PRICE, "property price exceeds cap");
        self.assert_event_capacity(1);
        property.price = price.0;
        property.for_sale = true;
        self.properties.insert(&property_id, &property);
        let reference = self.next_admin_reference(&format!("property:{property_id}:list"));
        self.emit(
            "property_listed",
            None,
            None,
            0,
            Some(&reference),
            &format!("property:{property_id}"),
            serde_json::json!({
                "id": property_id,
                "owner_wallet": property.owner,
                "listing_price": U128(price.0),
                "for_sale": true,
            }),
        );
        true
    }

    pub fn cancel_property_listing(&mut self, property_id: u64) -> bool {
        let mut property = self.properties.get(&property_id).expect("unknown property");
        let account = env::predecessor_account_id();
        require!(
            account == self.operator || property.owner == player_wallet(&account),
            "only the owner or operator may cancel this listing"
        );
        require!(property.for_sale, "property is not listed");
        self.assert_event_capacity(1);
        property.for_sale = false;
        property.price = 0;
        self.properties.insert(&property_id, &property);
        let reference = self.next_admin_reference(&format!("property:{property_id}:cancel"));
        self.emit(
            "property_listing_cancelled",
            None,
            None,
            0,
            Some(&reference),
            &format!("property:{property_id}"),
            serde_json::json!({ "id": property_id, "owner_wallet": property.owner }),
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
        let next_transfer_count = property
            .transfer_count
            .checked_add(1)
            .expect("property transfer counter overflow");
        self.assert_event_capacity(1);
        self.transfer_internal(&buyer, &seller, price);
        property.owner = buyer.clone();
        property.price = 0;
        property.for_sale = false;
        property.transfer_count = next_transfer_count;
        self.properties.insert(&property_id, &property);
        self.emit(
            "property_transferred",
            Some(&buyer),
            Some(&seller),
            price,
            Some(&format!(
                "property:{property_id}:{}",
                property.transfer_count
            )),
            &format!("property:{property_id}"),
            serde_json::json!({
                "id": property_id,
                "previous_owner": seller,
                "new_owner": buyer,
                "transfer_count": property.transfer_count,
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
        validate_text(&name, "business name", MAX_BUSINESS_NAME_LEN);

        let id = self.next_business_id;
        let treasury = format!("biz:{id}");
        require!(
            self.wallets.get(&treasury).is_none(),
            "business treasury already exists"
        );
        let next_business_id = self
            .next_business_id
            .checked_add(1)
            .expect("business id overflow");

        let buyer_wallet = player_wallet(&account);
        self.assert_event_capacity(2);
        self.burn(&buyer_wallet, BUSINESS_PERMIT_FEE);
        self.next_business_id = next_business_id;
        self.wallets.insert(&treasury, &0u128);
        self.businesses.insert(
            &id,
            &Business {
                id,
                name: name.clone(),
                owner: account.clone(),
                property_id,
                treasury: treasury.clone(),
                revenue_total: 0,
            },
        );
        self.business_by_property.insert(&property_id, &id);
        self.emit(
            "permit_burn",
            Some(&buyer_wallet),
            None,
            BUSINESS_PERMIT_FEE,
            Some(&format!("permit:{id}")),
            &format!("business:{id}"),
            serde_json::json!({ "business_id": id }),
        );
        let reference = format!("business:{id}:create");
        self.emit(
            "business_created",
            None,
            None,
            0,
            Some(&reference),
            &format!("business:{id}"),
            serde_json::json!({
                "id": id,
                "name": name,
                "owner": account,
                "owner_wallet": buyer_wallet,
                "property_id": property_id,
                "treasury": treasury,
                "permit_fee": U128(BUSINESS_PERMIT_FEE),
            }),
        );
        id
    }

    pub fn pay_service(&mut self, business_id: u64, amount: U128) -> bool {
        let account = env::predecessor_account_id();
        require!(
            self.players.get(&account).is_some(),
            "player not registered"
        );
        require!(amount.0 > 0, "amount must be positive");
        require!(
            amount.0 <= MAX_SERVICE_PAYMENT,
            "service payment exceeds cap"
        );
        let mut business = self.businesses.get(&business_id).expect("unknown business");
        let from = player_wallet(&account);
        let new_revenue = Self::add_checked(
            business.revenue_total,
            amount.0,
            "business revenue overflow",
        );
        self.assert_event_capacity(1);
        self.transfer_internal(&from, &business.treasury, amount.0);
        business.revenue_total = new_revenue;
        self.businesses.insert(&business_id, &business);
        self.emit(
            "service_paid",
            Some(&from),
            Some(&business.treasury),
            amount.0,
            Some(&format!("service:{business_id}:{}", self.tx_count)),
            &format!("business:{business_id}"),
            serde_json::json!({ "business_id": business_id }),
        );
        true
    }

    pub fn business_withdraw(&mut self, business_id: u64, amount: U128) -> bool {
        let account = env::predecessor_account_id();
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= MAX_QC_TRANSFER, "amount exceeds per-call cap");
        let business = self.businesses.get(&business_id).expect("unknown business");
        require!(
            business.owner == account,
            "only the business owner may withdraw"
        );
        let owner_wallet = player_wallet(&account);
        let treasury = business.treasury.clone();
        self.assert_event_capacity(1);
        self.transfer_internal(&treasury, &owner_wallet, amount.0);
        self.emit(
            "business_withdrawal",
            Some(&treasury),
            Some(&owner_wallet),
            amount.0,
            Some(&format!("withdrawal:{business_id}:{}", self.tx_count)),
            &format!("business:{business_id}"),
            serde_json::json!({ "business_id": business_id }),
        );
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
        let previous_wallet = player_wallet(&previous);
        let new_wallet = player_wallet(&new_owner);
        self.assert_event_capacity(1);
        business.owner = new_owner.clone();
        self.businesses.insert(&business_id, &business);
        let reference = self.next_admin_reference(&format!("business:{business_id}:transfer"));
        self.emit(
            "business_transferred",
            None,
            None,
            0,
            Some(&reference),
            &format!("business:{business_id}"),
            serde_json::json!({
                "id": business_id,
                "previous_owner": previous,
                "new_owner": new_owner,
                "previous_owner_wallet": previous_wallet,
                "new_owner_wallet": new_wallet,
            }),
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
        self.assert_not_paused();
        validate_wallet(&employer_wallet);
        validate_wallet(&employee_wallet);
        validate_reference(&reference);
        require!(amount.0 > 0, "amount must be positive");
        require!(amount.0 <= MAX_JOB_PAYMENT, "job payment exceeds cap");
        require!(
            self.wallets.get(&employer_wallet).is_some(),
            "unknown employer wallet"
        );
        require!(
            self.wallets.get(&employee_wallet).is_some(),
            "unknown employee wallet"
        );
        self.assert_reference_available(&reference);
        self.assert_event_capacity(1);
        self.transfer_internal(&employer_wallet, &employee_wallet, amount.0);
        self.mark_reference(&reference);
        self.emit(
            "job_reward",
            Some(&employer_wallet),
            Some(&employee_wallet),
            amount.0,
            Some(&reference),
            &employee_wallet,
            serde_json::json!({}),
        );
        true
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_operator();
        self.assert_event_capacity(1);
        self.paused = paused;
        let reference = self.next_admin_reference("operator:pause");
        self.emit(
            if paused { "paused" } else { "unpaused" },
            None,
            None,
            0,
            Some(&reference),
            &format!("operator:{}", self.operator),
            serde_json::json!({ "paused": paused }),
        );
    }

    pub fn propose_operator(&mut self, new_operator: AccountId) {
        self.assert_operator();
        require!(
            new_operator != self.operator,
            "new operator must differ from the current operator"
        );
        self.assert_event_capacity(1);
        self.pending_operator = Some(new_operator.clone());
        let reference = self.next_admin_reference("operator:propose");
        self.emit(
            "operator_proposed",
            None,
            None,
            0,
            Some(&reference),
            &format!("operator:{}", self.operator),
            serde_json::json!({ "new_operator": new_operator }),
        );
    }

    pub fn accept_operator(&mut self) {
        let pending = self
            .pending_operator
            .clone()
            .expect("no operator change is pending");
        require!(
            env::predecessor_account_id() == pending,
            "only the proposed operator may accept"
        );
        self.assert_event_capacity(1);
        let previous = self.operator.clone();
        self.operator = pending.clone();
        self.pending_operator = None;
        let reference = self.next_admin_reference("operator:accept");
        self.emit(
            "operator_changed",
            None,
            None,
            0,
            Some(&reference),
            &format!("operator:{pending}"),
            serde_json::json!({ "previous_operator": previous, "new_operator": pending }),
        );
    }

    pub fn cancel_operator_change(&mut self) {
        self.assert_operator();
        self.assert_event_capacity(1);
        self.pending_operator = None;
        let reference = self.next_admin_reference("operator:cancel");
        self.emit(
            "operator_change_cancelled",
            None,
            None,
            0,
            Some(&reference),
            &format!("operator:{}", self.operator),
            serde_json::json!({}),
        );
    }

    /// Testnet-only demo helper: wipes game state so the demo can be re-recorded.
    #[cfg(feature = "demo-reset")]
    pub fn reset_demo(&mut self) {
        self.assert_operator();
        self.players.clear();
        self.wallets.clear();
        self.properties.clear();
        self.property_by_coord.clear();
        self.businesses.clear();
        self.business_by_property.clear();
        self.processed_references.clear();
        self.next_property_id = 1;
        self.next_business_id = 1;
        // Demo reset intentionally starts a fresh event sequence; no capacity
        // check is needed because the first fresh event is seq 1.
        self.event_seq = 0;
        self.total_issued = 0;
        self.total_burned = 0;
        self.tx_count = 0;
        self.pending_operator = None;
        self.paused = false;
        let reference = self.next_admin_reference("demo:reset");
        self.emit(
            "demo_reset",
            None,
            None,
            0,
            Some(&reference),
            "city",
            serde_json::json!({}),
        );
    }

    pub fn is_reference_processed(&self, reference: String) -> bool {
        self.processed_references.contains(&reference.to_string())
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

    /// Returns up to `limit` properties starting at zero-based offset `from_index`.
    /// `limit` is clamped to 100; an offset at or beyond the collection returns empty.
    /// Properties are append-only (no delete method), so `UnorderedMap` iteration is
    /// insertion-ordered and stable across calls for this lifecycle.
    pub fn get_properties(&self, from_index: u64, limit: u64) -> Vec<Property> {
        let Some((start, limit)) = Self::page_bounds(from_index, limit, self.properties.len())
        else {
            return Vec::new();
        };
        self.properties
            .iter()
            .skip(start)
            .take(limit)
            .map(|(_, value)| value)
            .collect()
    }

    pub fn get_business(&self, business_id: u64) -> Option<Business> {
        self.businesses.get(&business_id)
    }

    /// Returns up to `limit` businesses starting at zero-based offset `from_index`.
    /// `limit` is clamped to 100; an offset at or beyond the collection returns empty.
    /// Businesses are append-only (no delete method), so `UnorderedMap` iteration is
    /// insertion-ordered and stable across calls for this lifecycle.
    pub fn get_businesses(&self, from_index: u64, limit: u64) -> Vec<Business> {
        let Some((start, limit)) = Self::page_bounds(from_index, limit, self.businesses.len())
        else {
            return Vec::new();
        };
        self.businesses
            .iter()
            .skip(start)
            .take(limit)
            .map(|(_, value)| value)
            .collect()
    }

    pub fn get_wallet_count(&self) -> u64 {
        self.wallets.len()
    }

    /// Returns up to `limit` wallets starting at zero-based offset `from_index`.
    /// Wallets are append-only for this lifecycle, so iteration order is stable.
    pub fn get_wallets(&self, from_index: u64, limit: u64) -> Vec<WalletBalance> {
        let Some((start, limit)) = Self::page_bounds(from_index, limit, self.wallets.len()) else {
            return Vec::new();
        };
        self.wallets
            .iter()
            .skip(start)
            .take(limit)
            .map(|(wallet_id, balance)| WalletBalance {
                wallet_id,
                balance: U128(balance),
            })
            .collect()
    }

    pub fn get_stats(&self) -> CityStats {
        CityStats {
            players: self.players.len(),
            properties: self.properties.len(),
            businesses: self.businesses.len(),
            total_issued: U128(self.total_issued),
            total_burned: U128(self.total_burned),
            tx_count: self.tx_count,
            paused: self.paused,
            pending_operator: self.pending_operator.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};
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

    fn expect_panic(f: impl FnOnce()) {
        let result = catch_unwind(AssertUnwindSafe(f));
        assert!(result.is_err(), "expected a panic");
    }

    fn events() -> Vec<serde_json::Value> {
        get_logs()
            .iter()
            .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
            .map(|json| serde_json::from_str(json).unwrap())
            .collect()
    }

    fn last_event() -> serde_json::Value {
        events().pop().expect("an event was emitted")
    }

    fn event_data(event: &serde_json::Value) -> &serde_json::Value {
        &event["data"][0]
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
        assert_eq!(contract.get_stats().tx_count, 1);
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

        let event = last_event();
        assert_eq!(event["event"], "property_transferred");
        let data = event_data(&event);
        assert_eq!(data["wallet_from"], "player:alice.testnet");
        assert_eq!(data["wallet_to"], "npc:professor-kofi");
        assert_eq!(data["amount"], "300");
        assert_eq!(data["previous_owner"], "npc:professor-kofi");
        assert_eq!(data["new_owner"], "player:alice.testnet");
    }

    #[test]
    fn property_transfer_count_overflow_fails_before_balance_write() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        let mut property = contract.properties.get(&1).expect("property exists");
        property.transfer_count = u64::MAX;
        contract.properties.insert(&1, &property);

        let buyer_before = contract.get_balance("player:alice.testnet".to_string()).0;
        let seller_before = contract.get_balance("npc:professor-kofi".to_string()).0;
        let owner_before = property.owner.clone();
        let price_before = property.price;
        let for_sale_before = property.for_sale;
        let transfer_before = property.transfer_count;
        let tx_before = contract.get_stats().tx_count;
        let seq_before = contract.event_seq;
        let issued_before = contract.get_stats().total_issued.0;
        let burned_before = contract.get_stats().total_burned.0;

        as_account("alice.testnet");
        expect_panic(|| {
            contract.buy_property(1);
        });

        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            buyer_before
        );
        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            seller_before
        );
        let after = contract.get_property(1).expect("property exists");
        assert_eq!(after.owner, owner_before);
        assert_eq!(after.price, price_before);
        assert_eq!(after.for_sale, for_sale_before);
        assert_eq!(after.transfer_count, transfer_before);
        assert_eq!(contract.get_stats().tx_count, tx_before);
        assert_eq!(contract.event_seq, seq_before);
        assert_eq!(contract.get_stats().total_issued.0, issued_before);
        assert_eq!(contract.get_stats().total_burned.0, burned_before);
        assert!(events().is_empty());
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
        assert!(contract.is_reference_processed("job-1".to_string()));
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

    #[cfg(feature = "demo-reset")]
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
            "quiz:1".to_string(),
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            600
        );
        assert_eq!(contract.get_stats().total_issued.0, 1_600);
    }

    #[test]
    fn reward_reference_is_idempotent() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(100),
            "quiz:attempt-1".to_string(),
        );
        let issued = contract.get_stats().total_issued.0;
        let balance = contract.get_balance("player:alice.testnet".to_string()).0;

        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(100),
                "quiz:attempt-1".to_string(),
            );
        });

        assert_eq!(contract.get_stats().total_issued.0, issued);
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            balance
        );
    }

    #[test]
    fn pay_job_reference_is_idempotent() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(100),
            "job:1".to_string(),
        );
        let employer = contract.get_balance("npc:professor-kofi".to_string()).0;
        let employee = contract.get_balance("player:alice.testnet".to_string()).0;

        expect_panic(|| {
            contract.pay_job(
                "npc:professor-kofi".to_string(),
                "player:alice.testnet".to_string(),
                U128(100),
                "job:1".to_string(),
            );
        });

        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            employer
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            employee
        );
    }

    #[test]
    fn different_references_pay_independently() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(100),
            "job:1".to_string(),
        );
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(100),
            "job:2".to_string(),
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            700
        );
    }

    #[test]
    fn failed_payment_does_not_consume_reference() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        expect_panic(|| {
            contract.pay_job(
                "npc:professor-kofi".to_string(),
                "player:alice.testnet".to_string(),
                U128(5_000),
                "job:failed".to_string(),
            );
        });
        assert!(!contract.is_reference_processed("job:failed".to_string()));

        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(100),
            "job:failed".to_string(),
        );
        assert!(contract.is_reference_processed("job:failed".to_string()));
    }

    #[test]
    fn reference_validation_rejects_empty_whitespace_and_oversize() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(10),
                "   ".to_string(),
            );
        });
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(10),
                "x".repeat(MAX_REFERENCE_LEN + 1),
            );
        });
    }

    #[test]
    fn numeric_caps_are_enforced() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(MAX_REWARD_PER_CALL + 1),
                "quiz:cap".to_string(),
            );
        });
        expect_panic(|| {
            contract.create_wallet("npc:whale".to_string(), U128(MAX_INITIAL_BALANCE + 1));
        });
        expect_panic(|| {
            contract.create_property(
                "plot".to_string(),
                "cap".to_string(),
                0,
                0,
                "npc:professor-kofi".to_string(),
                U128(MAX_PROPERTY_PRICE + 1),
            );
        });
        expect_panic(|| {
            contract.list_property(1, U128(MAX_PROPERTY_PRICE + 1));
        });

        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.create_wallet("npc:merchant".to_string(), U128(0));
        as_account("alice.testnet");
        expect_panic(|| {
            contract.transfer_qc("npc:merchant".to_string(), U128(MAX_QC_TRANSFER + 1));
        });
    }

    #[test]
    fn supply_cap_blocks_new_issuance() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.total_issued = MAX_TOTAL_SUPPLY;
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(1),
                "quiz:overflow".to_string(),
            );
        });
        assert_eq!(contract.get_stats().total_issued.0, MAX_TOTAL_SUPPLY);
    }

    #[test]
    fn duplicate_coordinates_are_rejected() {
        let mut contract = setup();
        expect_panic(|| {
            contract.create_property(
                "plot".to_string(),
                "knowledge".to_string(),
                4,
                7,
                "npc:professor-kofi".to_string(),
                U128(100),
            );
        });
    }

    #[test]
    fn invalid_wallet_prefixes_are_rejected() {
        let mut contract = setup();
        expect_panic(|| {
            contract.create_wallet("treasury:main".to_string(), U128(0));
        });
        expect_panic(|| {
            contract.create_wallet("player:UPPER".to_string(), U128(0));
        });
        expect_panic(|| {
            contract.create_wallet("player:".to_string(), U128(0));
        });
    }

    #[test]
    fn invalid_names_are_rejected() {
        let mut contract = setup();
        as_account("alice.testnet");
        expect_panic(|| {
            contract.register_player(" alice".to_string());
        });
        expect_panic(|| {
            contract.register_player("a".repeat(MAX_USERNAME_LEN + 1));
        });
        expect_panic(|| {
            contract.register_player("ali\nce".to_string());
        });
    }

    #[test]
    fn business_cannot_be_created_twice_on_a_property() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.buy_property(1);
        contract.create_business(1, "First".to_string());
        expect_panic(|| {
            contract.create_business(1, "Second".to_string());
        });
    }

    #[test]
    fn owner_can_cancel_a_listing() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        contract.buy_property(1);
        as_account("quizcity.testnet");
        contract.list_property(1, U128(400));
        as_account("alice.testnet");
        contract.cancel_property_listing(1);
        let property = contract.get_property(1).unwrap();
        assert!(!property.for_sale);
        assert_eq!(property.price, 0);
        expect_panic(|| {
            contract.cancel_property_listing(1);
        });
        assert_eq!(last_event()["event"], "property_listing_cancelled");
    }

    fn property_ids(properties: Vec<Property>) -> Vec<u64> {
        properties.into_iter().map(|property| property.id).collect()
    }

    fn business_ids(businesses: Vec<Business>) -> Vec<u64> {
        businesses.into_iter().map(|business| business.id).collect()
    }

    #[test]
    fn property_pages_return_exact_ids_and_stable_order() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        for x in 0..12 {
            contract.create_property(
                "plot".to_string(),
                "arts".to_string(),
                x,
                1,
                "npc:professor-kofi".to_string(),
                U128(0),
            );
        }
        let all = property_ids(contract.get_properties(0, 1_000));
        assert_eq!(all.len(), 13);
        assert_eq!(property_ids(contract.get_properties(0, 5)), all[0..5]);
        assert_eq!(property_ids(contract.get_properties(10, 5)), all[10..13]);
        assert_eq!(property_ids(contract.get_properties(12, 100)), all[12..13]);
        assert_eq!(
            property_ids(contract.get_properties(13, 10)),
            Vec::<u64>::new()
        );
        assert_eq!(
            property_ids(contract.get_properties(14, 10)),
            Vec::<u64>::new()
        );
        assert_eq!(
            property_ids(contract.get_properties(u64::MAX, 10)),
            Vec::<u64>::new()
        );
        assert_eq!(
            property_ids(contract.get_properties(0, 0)),
            Vec::<u64>::new()
        );
        assert_eq!(property_ids(contract.get_properties(0, 100)), all[0..13]);
        assert_eq!(contract.get_properties(0, 1_000).len(), 13);
        assert_eq!(Contract::page_bounds(0, 1_000, 200), Some((0, 100)));
        assert_eq!(Contract::page_bounds(200, 100, 200), None);
        assert_eq!(
            property_ids(contract.get_properties(0, 100)),
            property_ids(contract.get_properties(0, 100))
        );
    }

    #[test]
    fn business_pages_return_exact_ids_and_stable_order() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        for x in 0..6 {
            contract.create_property(
                "plot".to_string(),
                "arts".to_string(),
                x,
                2,
                "player:alice.testnet".to_string(),
                U128(0),
            );
        }
        as_account("alice.testnet");
        for index in 2..6 {
            contract.create_business(index, format!("Business {index}"));
        }
        let all = business_ids(contract.get_businesses(0, 100));
        assert_eq!(all.len(), 4);
        assert_eq!(business_ids(contract.get_businesses(0, 2)), all[0..2]);
        assert_eq!(business_ids(contract.get_businesses(2, 2)), all[2..4]);
        assert_eq!(
            business_ids(contract.get_businesses(4, 2)),
            Vec::<u64>::new()
        );
        assert_eq!(
            business_ids(contract.get_businesses(u64::MAX, 2)),
            Vec::<u64>::new()
        );
        assert_eq!(contract.get_businesses(0, 0).len(), 0);
        assert_eq!(
            business_ids(contract.get_businesses(0, 100)),
            business_ids(contract.get_businesses(0, 100))
        );
    }

    #[test]
    fn empty_collections_return_empty_pages() {
        as_account("quizcity.testnet");
        let contract = Contract::new();
        assert_eq!(contract.get_properties(0, 10).len(), 0);
        assert_eq!(contract.get_businesses(0, 10).len(), 0);
        assert_eq!(contract.get_properties(0, 0).len(), 0);
    }

    #[test]
    fn empty_collection_offsets_do_not_fetch() {
        as_account("quizcity.testnet");
        let contract = Contract::new();
        assert!(contract.get_properties(u64::MAX, 100).is_empty());
        assert!(contract.get_businesses(u64::MAX, 100).is_empty());
    }

    #[test]
    fn events_have_canonical_shape_and_increasing_sequence() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(25),
            "quiz:event-1".to_string(),
        );
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(25),
            "quiz:event-2".to_string(),
        );

        let all = events();
        let first = &all[all.len() - 2];
        let second = &all[all.len() - 1];
        assert_eq!(first["standard"], "quizcity");
        assert_eq!(first["version"], "1.0.0");
        assert_eq!(first["event"], "reward_issued");
        let data = event_data(first);
        assert!(data["seq"].is_u64());
        assert_eq!(data["wallet_from"], serde_json::Value::Null);
        assert_eq!(data["wallet_to"], "player:alice.testnet");
        assert_eq!(data["amount"], "25");
        assert_eq!(data["reference"], "quiz:event-1");
        assert_eq!(data["entity_id"], "player:alice.testnet");
        assert_eq!(
            event_data(second)["seq"].as_u64().unwrap(),
            data["seq"].as_u64().unwrap() + 1
        );
    }

    #[test]
    fn operator_rotation_is_two_step() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        contract.propose_operator(account("next-operator.testnet"));
        assert_eq!(
            contract.get_stats().pending_operator,
            Some(account("next-operator.testnet"))
        );
        as_account("intruder.testnet");
        expect_panic(|| contract.accept_operator());
        as_account("next-operator.testnet");
        contract.accept_operator();
        assert_eq!(contract.get_stats().pending_operator, None);

        as_account("quizcity.testnet");
        expect_panic(|| contract.set_paused(true));
        as_account("next-operator.testnet");
        contract.set_paused(true);
        assert!(contract.get_stats().paused);
    }

    #[test]
    fn pause_blocks_operator_payouts_without_changing_balances() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.set_paused(true);
        let issued = contract.get_stats().total_issued.0;
        let employer = contract.get_balance("npc:professor-kofi".to_string()).0;

        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(10),
                "quiz:paused".to_string(),
            );
        });
        expect_panic(|| {
            contract.pay_job(
                "npc:professor-kofi".to_string(),
                "player:alice.testnet".to_string(),
                U128(100),
                "job:paused".to_string(),
            );
        });

        assert_eq!(contract.get_stats().total_issued.0, issued);
        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            employer
        );
        as_account("quizcity.testnet");
        contract.set_paused(false);
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(10),
            "quiz:unpaused".to_string(),
        );
    }

    #[test]
    fn non_operators_cannot_pause_or_propose() {
        let mut contract = setup();
        as_account("alice.testnet");
        expect_panic(|| contract.set_paused(true));
        expect_panic(|| contract.propose_operator(account("alice.testnet")));
    }
    fn set_balance(contract: &mut Contract, wallet: &str, amount: u128) {
        contract.wallets.insert(&wallet.to_string(), &amount);
    }

    #[test]
    fn reward_exact_cap_succeeds_and_above_cap_preserves_state() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        as_account("quizcity.testnet");
        let before = contract.get_balance("player:alice.testnet".to_string()).0;
        let stats = contract.get_stats();

        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(MAX_REWARD_PER_CALL),
            "quiz:exact-cap".to_string(),
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            before + MAX_REWARD_PER_CALL
        );
        assert!(contract.is_reference_processed("quiz:exact-cap".to_string()));

        let balance = contract.get_balance("player:alice.testnet".to_string()).0;
        let issued = contract.get_stats().total_issued.0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(MAX_REWARD_PER_CALL + 1),
                "quiz:above-cap".to_string(),
            );
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            balance
        );
        assert_eq!(contract.get_stats().total_issued.0, issued);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
        assert!(!contract.is_reference_processed("quiz:above-cap".to_string()));
        assert_eq!(stats.players, contract.get_stats().players);
    }

    #[test]
    fn job_payment_exact_cap_succeeds_and_above_cap_preserves_state() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        as_account("quizcity.testnet");
        set_balance(&mut contract, "npc:professor-kofi", MAX_JOB_PAYMENT + 1);
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:alice.testnet".to_string(),
            U128(MAX_JOB_PAYMENT),
            "job:exact-cap".to_string(),
        );
        assert_eq!(contract.get_balance("npc:professor-kofi".to_string()).0, 1);
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            MAX_JOB_PAYMENT
        );

        let employer = contract.get_balance("npc:professor-kofi".to_string()).0;
        let employee = contract.get_balance("player:alice.testnet".to_string()).0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.pay_job(
                "npc:professor-kofi".to_string(),
                "player:alice.testnet".to_string(),
                U128(MAX_JOB_PAYMENT + 1),
                "job:above-cap".to_string(),
            );
        });
        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            employer
        );
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            employee
        );
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
        assert!(!contract.is_reference_processed("job:above-cap".to_string()));
    }

    #[test]
    fn service_payment_exact_cap_succeeds_and_above_cap_preserves_state() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.create_property(
            "venue".to_string(),
            "arts".to_string(),
            8,
            8,
            "player:alice.testnet".to_string(),
            U128(0),
        );
        as_account("alice.testnet");
        contract.create_business(2, "Cafe".to_string());
        set_balance(
            &mut contract,
            "player:alice.testnet",
            MAX_SERVICE_PAYMENT + 1,
        );

        contract.pay_service(1, U128(MAX_SERVICE_PAYMENT));
        assert_eq!(
            contract.get_balance("biz:1".to_string()).0,
            MAX_SERVICE_PAYMENT
        );
        assert_eq!(
            contract.get_business(1).unwrap().revenue_total,
            MAX_SERVICE_PAYMENT
        );

        let payer = contract.get_balance("player:alice.testnet".to_string()).0;
        let treasury = contract.get_balance("biz:1".to_string()).0;
        let revenue = contract.get_business(1).unwrap().revenue_total;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.pay_service(1, U128(MAX_SERVICE_PAYMENT + 1));
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            payer
        );
        assert_eq!(contract.get_balance("biz:1".to_string()).0, treasury);
        assert_eq!(contract.get_business(1).unwrap().revenue_total, revenue);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
    }

    #[test]
    fn property_prices_accept_exact_cap_and_reject_above_without_changes() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        let id = contract.create_property(
            "plot".to_string(),
            "arts".to_string(),
            1,
            1,
            "npc:professor-kofi".to_string(),
            U128(MAX_PROPERTY_PRICE),
        );
        let property = contract.get_property(id).unwrap();
        assert_eq!(property.price, MAX_PROPERTY_PRICE);
        assert!(property.for_sale);

        let stats = contract.get_stats();
        let next_id = contract.next_property_id;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.create_property(
                "plot".to_string(),
                "arts".to_string(),
                2,
                1,
                "npc:professor-kofi".to_string(),
                U128(MAX_PROPERTY_PRICE + 1),
            );
        });
        assert_eq!(contract.get_stats().properties, stats.properties);
        assert_eq!(contract.next_property_id, next_id);
        assert_eq!(contract.event_seq, seq);

        contract.list_property(1, U128(MAX_PROPERTY_PRICE));
        assert_eq!(contract.get_property(1).unwrap().price, MAX_PROPERTY_PRICE);
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.list_property(1, U128(MAX_PROPERTY_PRICE + 1));
        });
        assert_eq!(contract.get_property(1).unwrap().price, MAX_PROPERTY_PRICE);
        assert!(contract.get_property(1).unwrap().for_sale);
        assert_eq!(contract.event_seq, seq);
    }

    #[test]
    fn transfer_exact_cap_succeeds_and_above_cap_preserves_state() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        as_account("alice.testnet");
        set_balance(&mut contract, "player:alice.testnet", MAX_QC_TRANSFER + 1);
        contract.transfer_qc("player:bob.testnet".to_string(), U128(MAX_QC_TRANSFER));
        assert_eq!(
            contract.get_balance("player:bob.testnet".to_string()).0,
            MAX_QC_TRANSFER + 500
        );

        let from = contract.get_balance("player:alice.testnet".to_string()).0;
        let to = contract.get_balance("player:bob.testnet".to_string()).0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.transfer_qc("player:bob.testnet".to_string(), U128(MAX_QC_TRANSFER + 1));
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            from
        );
        assert_eq!(contract.get_balance("player:bob.testnet".to_string()).0, to);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
    }

    #[test]
    fn initial_wallet_balance_accepts_exact_cap_and_rejects_above() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        contract.create_wallet("npc:whale".to_string(), U128(MAX_INITIAL_BALANCE));
        assert_eq!(
            contract.get_balance("npc:whale".to_string()).0,
            MAX_INITIAL_BALANCE
        );

        let issued = contract.get_stats().total_issued.0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.create_wallet("npc:whale-over".to_string(), U128(MAX_INITIAL_BALANCE + 1));
        });
        assert_eq!(contract.get_balance("npc:whale-over".to_string()).0, 0);
        assert_eq!(contract.get_stats().total_issued.0, issued);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
    }

    #[test]
    fn supply_cap_accepts_exact_maximum_and_rejects_one_more() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        as_account("quizcity.testnet");
        contract.total_issued = MAX_TOTAL_SUPPLY - 1;
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(1),
            "quiz:supply-exact".to_string(),
        );
        assert_eq!(contract.get_stats().total_issued.0, MAX_TOTAL_SUPPLY);
        let balance = contract.get_balance("player:alice.testnet".to_string()).0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(1),
                "quiz:supply-over".to_string(),
            );
        });
        assert_eq!(contract.get_stats().total_issued.0, MAX_TOTAL_SUPPLY);
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            balance
        );
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
        assert!(!contract.is_reference_processed("quiz:supply-over".to_string()));
    }

    #[test]
    fn wallet_balance_overflow_fails_before_any_write() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        as_account("quizcity.testnet");
        set_balance(&mut contract, "player:alice.testnet", u128::MAX - 1);
        let issued = contract.get_stats().total_issued.0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.credit_reward(
                "player:alice.testnet".to_string(),
                U128(2),
                "quiz:overflow".to_string(),
            );
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            u128::MAX - 1
        );
        assert_eq!(contract.get_stats().total_issued.0, issued);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
        assert!(!contract.is_reference_processed("quiz:overflow".to_string()));
    }

    #[test]
    fn recipient_balance_overflow_fails_before_any_write() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        as_account("alice.testnet");
        set_balance(&mut contract, "player:alice.testnet", 10);
        set_balance(&mut contract, "player:bob.testnet", u128::MAX);
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        expect_panic(|| {
            contract.transfer_qc("player:bob.testnet".to_string(), U128(1));
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            10
        );
        assert_eq!(
            contract.get_balance("player:bob.testnet".to_string()).0,
            u128::MAX
        );
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
    }

    #[test]
    fn burn_counter_overflow_fails_before_any_write() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.create_property(
            "venue".to_string(),
            "arts".to_string(),
            9,
            9,
            "player:alice.testnet".to_string(),
            U128(0),
        );
        contract.total_burned = u128::MAX;
        as_account("alice.testnet");
        let balance = contract.get_balance("player:alice.testnet".to_string()).0;
        let tx = contract.get_stats().tx_count;
        let seq = contract.event_seq;
        let next_business = contract.next_business_id;
        expect_panic(|| {
            contract.create_business(2, "Cafe".to_string());
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            balance
        );
        assert_eq!(contract.get_stats().total_burned.0, u128::MAX);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, seq);
        assert_eq!(contract.next_business_id, next_business);
    }

    #[test]
    fn tx_count_overflow_fails_before_any_balance_write() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        let alice_before = contract.get_balance("player:alice.testnet".to_string()).0;
        let kofi_before = contract.get_balance("npc:professor-kofi".to_string()).0;
        let issued = contract.get_stats().total_issued.0;
        let burned = contract.get_stats().total_burned.0;
        let seq = contract.event_seq;
        contract.tx_count = u64::MAX;
        expect_panic(|| {
            contract.transfer_qc("npc:professor-kofi".to_string(), U128(10));
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            alice_before
        );
        assert_eq!(
            contract.get_balance("npc:professor-kofi".to_string()).0,
            kofi_before
        );
        assert_eq!(contract.get_stats().total_issued.0, issued);
        assert_eq!(contract.get_stats().total_burned.0, burned);
        assert_eq!(contract.get_stats().tx_count, u64::MAX);
        assert_eq!(contract.event_seq, seq);
    }

    #[test]
    fn event_sequence_overflow_fails_before_any_state_write() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        let tx = contract.get_stats().tx_count;
        contract.event_seq = u64::MAX;
        expect_panic(|| contract.set_paused(true));
        assert!(!contract.get_stats().paused);
        assert_eq!(contract.event_seq, u64::MAX);

        as_account("bob.testnet");
        expect_panic(|| {
            contract.register_player("bob".to_string());
        });
        assert!(contract.get_player(account("bob.testnet")).is_none());
        assert_eq!(contract.get_stats().players, 0);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.event_seq, u64::MAX);
        assert!(events().is_empty());
    }

    #[test]
    fn property_id_overflow_fails_before_any_state_write() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        let properties = contract.get_stats().properties;
        let seq = contract.event_seq;
        let tx = contract.get_stats().tx_count;
        contract.next_property_id = u64::MAX;
        expect_panic(|| {
            contract.create_property(
                "plot".to_string(),
                "overflow".to_string(),
                0,
                0,
                "npc:professor-kofi".to_string(),
                U128(0),
            );
        });
        assert_eq!(contract.get_stats().properties, properties);
        assert_eq!(contract.next_property_id, u64::MAX);
        assert_eq!(contract.event_seq, seq);
        assert_eq!(contract.get_stats().tx_count, tx);
        assert_eq!(contract.get_properties(0, 100).len(), properties as usize);
    }

    #[test]
    fn business_id_overflow_fails_before_any_state_write() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.create_property(
            "venue".to_string(),
            "arts".to_string(),
            11,
            11,
            "player:alice.testnet".to_string(),
            U128(0),
        );
        let balance = contract.get_balance("player:alice.testnet".to_string()).0;
        let businesses = contract.get_stats().businesses;
        let burned = contract.get_stats().total_burned.0;
        let seq = contract.event_seq;
        let tx = contract.get_stats().tx_count;
        contract.next_business_id = u64::MAX;
        as_account("alice.testnet");
        expect_panic(|| {
            contract.create_business(2, "Cafe".to_string());
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            balance
        );
        assert_eq!(contract.get_stats().businesses, businesses);
        assert_eq!(contract.get_stats().total_burned.0, burned);
        assert_eq!(contract.next_business_id, u64::MAX);
        assert_eq!(contract.event_seq, seq);
        assert_eq!(contract.get_stats().tx_count, tx);
    }

    #[test]
    fn operator_actions_emit_references() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        contract.create_wallet("npc:admin-test".to_string(), U128(0));
        assert_eq!(last_event()["event"], "wallet_created");
        assert!(event_data(&last_event())["reference"].is_string());

        contract.create_property(
            "plot".to_string(),
            "arts".to_string(),
            10,
            10,
            "npc:professor-kofi".to_string(),
            U128(0),
        );
        assert_eq!(last_event()["event"], "property_created");
        assert!(event_data(&last_event())["reference"].is_string());

        contract.list_property(1, U128(300));
        assert_eq!(last_event()["event"], "property_listed");
        assert!(event_data(&last_event())["reference"].is_string());
        contract.cancel_property_listing(1);
        assert_eq!(last_event()["event"], "property_listing_cancelled");
        assert!(event_data(&last_event())["reference"].is_string());

        contract.set_paused(true);
        assert_eq!(last_event()["event"], "paused");
        assert!(event_data(&last_event())["reference"].is_string());
    }

    #[cfg(feature = "demo-reset")]
    #[test]
    fn migrate_reset_is_contract_account_only() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        contract.propose_operator(account("next.testnet"));
        contract.set_paused(true);

        as_account("intruder.testnet");
        expect_panic(|| {
            let _ = Contract::migrate_reset();
        });

        as_account("quizcity.testnet");
        let migrated = Contract::migrate_reset();
        let stats = migrated.get_stats();
        assert_eq!(stats.players, 0);
        assert_eq!(stats.properties, 0);
        assert!(!stats.paused);
        assert_eq!(stats.pending_operator, None);
        assert_eq!(migrated.operator, account("quizcity.testnet"));
        assert_eq!(
            migrated.get_balance("player:alice.testnet".to_string()).0,
            0
        );
    }

    #[cfg(feature = "demo-reset")]
    #[test]
    fn reset_demo_requires_operator_and_clears_pending_state() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        contract.propose_operator(account("next.testnet"));
        contract.set_paused(true);

        as_account("intruder.testnet");
        expect_panic(|| contract.reset_demo());
        assert!(contract.get_stats().paused);

        as_account("quizcity.testnet");
        contract.reset_demo();
        let stats = contract.get_stats();
        assert_eq!(stats.players, 0);
        assert_eq!(stats.properties, 0);
        assert!(!stats.paused);
        assert_eq!(stats.pending_operator, None);
        assert_eq!(last_event()["event"], "demo_reset");
    }
    fn assert_event_shape(event: &serde_json::Value, name: &str) {
        assert_eq!(event["standard"], "quizcity");
        assert_eq!(event["version"], "1.0.0");
        assert_eq!(event["event"], name);
        let data = event["data"].as_array().expect("data array");
        assert_eq!(data.len(), 1);
        let entry = &data[0];
        assert!(entry["seq"].is_u64());
        assert!(entry["wallet_from"].is_string() || entry["wallet_from"].is_null());
        assert!(entry["wallet_to"].is_string() || entry["wallet_to"].is_null());
        let amount = entry["amount"].as_str().expect("amount string");
        assert!(amount.parse::<u128>().is_ok());
        assert!(entry["reference"].is_string() || entry["reference"].is_null());
        assert!(entry["entity_id"]
            .as_str()
            .map(|value| !value.is_empty())
            .unwrap_or(false));
    }

    fn named_events(all: &[serde_json::Value], name: &str) -> Vec<serde_json::Value> {
        all.iter()
            .filter(|event| event["event"] == name)
            .cloned()
            .collect()
    }

    #[test]
    fn all_event_types_follow_the_canonical_contract() {
        let mut contract = setup();
        // `testing_env!` replaces the VM context, which clears the log buffer, so
        // collect the events emitted in each context before switching accounts.
        let mut all = events();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        all.extend(events());
        as_account("quizcity.testnet");
        contract.credit_reward(
            "player:alice.testnet".to_string(),
            U128(25),
            "quiz:event-contract".to_string(),
        );
        all.extend(events());
        as_account("alice.testnet");
        contract.transfer_qc("npc:professor-kofi".to_string(), U128(10));
        contract.buy_property(1);
        contract.create_business(1, "Cafe".to_string());
        all.extend(events());
        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        contract.pay_service(1, U128(20));
        all.extend(events());
        as_account("alice.testnet");
        contract.business_withdraw(1, U128(20));
        contract.transfer_business(1, account("bob.testnet"));
        contract.list_property(1, U128(400));
        contract.cancel_property_listing(1);
        all.extend(events());
        as_account("quizcity.testnet");
        contract.pay_job(
            "npc:professor-kofi".to_string(),
            "player:bob.testnet".to_string(),
            U128(50),
            "job:event-contract".to_string(),
        );
        contract.set_paused(true);
        contract.set_paused(false);
        contract.propose_operator(account("next.testnet"));
        all.extend(events());
        as_account("next.testnet");
        contract.accept_operator();
        contract.propose_operator(account("quizcity.testnet"));
        all.extend(events());
        as_account("quizcity.testnet");
        contract.accept_operator();
        contract.propose_operator(account("cancel.testnet"));
        contract.cancel_operator_change();
        all.extend(events());

        for event in &all {
            let name = event["event"].as_str().expect("event name");
            assert_event_shape(event, name);
        }
        assert_eq!(contract.get_stats().tx_count, 10);
        assert_eq!(contract.event_seq, all.len() as u64);
        for (index, event) in all.iter().enumerate() {
            assert_eq!(event_data(event)["seq"].as_u64().unwrap(), index as u64 + 1);
        }

        let starter = &named_events(&all, "starter_allowance")[0];
        assert_eq!(event_data(starter)["wallet_from"], serde_json::Value::Null);
        assert_eq!(event_data(starter)["wallet_to"], "player:alice.testnet");
        assert_eq!(event_data(starter)["amount"], "500");

        let reward = &named_events(&all, "reward_issued")[0];
        assert_eq!(event_data(reward)["wallet_from"], serde_json::Value::Null);
        assert_eq!(event_data(reward)["wallet_to"], "player:alice.testnet");
        assert_eq!(event_data(reward)["amount"], "25");

        let transfer_event = &named_events(&all, "wallet_transfer")[0];
        assert_eq!(
            event_data(transfer_event)["wallet_from"],
            "player:alice.testnet"
        );
        assert_eq!(
            event_data(transfer_event)["wallet_to"],
            "npc:professor-kofi"
        );
        assert_eq!(event_data(transfer_event)["amount"], "10");

        let sale = &named_events(&all, "property_transferred")[0];
        assert_eq!(event_data(sale)["wallet_from"], "player:alice.testnet");
        assert_eq!(event_data(sale)["wallet_to"], "npc:professor-kofi");
        assert_eq!(event_data(sale)["previous_owner"], "npc:professor-kofi");
        assert_eq!(event_data(sale)["new_owner"], "player:alice.testnet");

        let burn = &named_events(&all, "permit_burn")[0];
        assert_eq!(event_data(burn)["wallet_from"], "player:alice.testnet");
        assert_eq!(event_data(burn)["wallet_to"], serde_json::Value::Null);
        assert_eq!(event_data(burn)["amount"], "100");

        let service = &named_events(&all, "service_paid")[0];
        assert_eq!(event_data(service)["wallet_from"], "player:bob.testnet");
        assert_eq!(event_data(service)["wallet_to"], "biz:1");
        assert_eq!(event_data(service)["amount"], "20");

        let withdrawal = &named_events(&all, "business_withdrawal")[0];
        assert_eq!(event_data(withdrawal)["wallet_from"], "biz:1");
        assert_eq!(event_data(withdrawal)["wallet_to"], "player:alice.testnet");
        assert_eq!(event_data(withdrawal)["amount"], "20");

        let job = &named_events(&all, "job_reward")[0];
        assert_eq!(event_data(job)["wallet_from"], "npc:professor-kofi");
        assert_eq!(event_data(job)["wallet_to"], "player:bob.testnet");
        assert_eq!(event_data(job)["amount"], "50");

        for name in [
            "player_registered",
            "property_created",
            "property_listed",
            "property_listing_cancelled",
            "business_created",
            "business_transferred",
            "paused",
            "unpaused",
            "operator_proposed",
            "operator_changed",
            "operator_change_cancelled",
        ] {
            let event = &named_events(&all, name)[0];
            assert_eq!(event_data(event)["wallet_from"], serde_json::Value::Null);
            assert_eq!(event_data(event)["wallet_to"], serde_json::Value::Null);
            assert_eq!(event_data(event)["amount"], "0");
            assert!(event_data(event)["reference"].is_string());
        }
        assert_eq!(
            event_data(&named_events(&all, "business_created")[0])["owner_wallet"],
            "player:alice.testnet"
        );
        assert_eq!(
            event_data(&named_events(&all, "property_listed")[0])["listing_price"],
            "400"
        );
        assert_eq!(
            event_data(&named_events(&all, "property_listing_cancelled")[0])["owner_wallet"],
            "player:alice.testnet"
        );
        assert_eq!(
            event_data(&named_events(&all, "business_transferred")[0])["new_owner"],
            "bob.testnet"
        );
        assert_eq!(
            event_data(&named_events(&all, "operator_changed")[0])["new_operator"],
            "next.testnet"
        );
    }

    #[test]
    fn privileged_seeding_and_property_listing_require_the_right_account() {
        let mut contract = setup();
        as_account("intruder.testnet");
        let wallets = contract.get_wallet_count();
        let properties = contract.get_stats().properties;
        expect_panic(|| {
            contract.create_wallet("gov:intruder".to_string(), U128(10));
        });
        expect_panic(|| {
            contract.create_property(
                "plot".to_string(),
                "knowledge".to_string(),
                9,
                9,
                "gov:intruder".to_string(),
                U128(10),
            );
        });
        assert_eq!(contract.get_wallet_count(), wallets);
        assert_eq!(contract.get_stats().properties, properties);

        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        expect_panic(|| {
            contract.list_property(1, U128(400));
        });
        expect_panic(|| {
            contract.cancel_property_listing(1);
        });

        as_account("quizcity.testnet");
        contract.list_property(1, U128(400));
        as_account("alice.testnet");
        contract.buy_property(1);
        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        expect_panic(|| {
            contract.list_property(1, U128(500));
        });

        as_account("alice.testnet");
        contract.list_property(1, U128(500));
        as_account("bob.testnet");
        expect_panic(|| {
            contract.cancel_property_listing(1);
        });
        as_account("alice.testnet");
        contract.cancel_property_listing(1);
        assert!(!contract.get_property(1).unwrap().for_sale);
    }

    #[test]
    fn business_creation_and_transfer_require_the_current_owner() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        contract.claim_starter();
        as_account("quizcity.testnet");
        contract.list_property(1, U128(300));
        as_account("alice.testnet");
        contract.buy_property(1);
        as_account("bob.testnet");
        contract.register_player("bob".to_string());
        contract.claim_starter();
        expect_panic(|| {
            contract.create_business(1, "Intruder Cafe".to_string());
        });
        expect_panic(|| {
            contract.transfer_business(1, account("bob.testnet"));
        });

        as_account("alice.testnet");
        let business_id = contract.create_business(1, "Cafe".to_string());
        as_account("bob.testnet");
        expect_panic(|| {
            contract.transfer_business(business_id, account("bob.testnet"));
        });
        as_account("alice.testnet");
        contract.transfer_business(business_id, account("bob.testnet"));
        assert_eq!(
            contract.get_business(business_id).unwrap().owner,
            "bob.testnet"
        );
    }

    #[test]
    fn operator_change_cancellation_is_operator_only_and_clears_pending() {
        let mut contract = setup();
        as_account("quizcity.testnet");
        contract.propose_operator(account("next-operator.testnet"));
        as_account("alice.testnet");
        expect_panic(|| {
            contract.cancel_operator_change();
        });
        assert_eq!(
            contract.get_stats().pending_operator,
            Some(account("next-operator.testnet"))
        );
        as_account("quizcity.testnet");
        contract.cancel_operator_change();
        assert_eq!(contract.get_stats().pending_operator, None);
        expect_panic(|| {
            contract.accept_operator();
        });
    }

    #[test]
    fn duplicate_registration_and_zero_transfer_preserve_state() {
        let mut contract = setup();
        as_account("alice.testnet");
        contract.register_player("alice".to_string());
        let players = contract.get_stats().players;
        expect_panic(|| {
            contract.register_player("alice-again".to_string());
        });
        assert_eq!(contract.get_stats().players, players);

        contract.claim_starter();
        let balance = contract.get_balance("player:alice.testnet".to_string()).0;
        expect_panic(|| {
            contract.transfer_qc("npc:professor-kofi".to_string(), U128(0));
        });
        assert_eq!(
            contract.get_balance("player:alice.testnet".to_string()).0,
            balance
        );
    }
}
