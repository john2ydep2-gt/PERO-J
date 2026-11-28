#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, vec, Address, Env,
    IntoVal, String, Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    InvalidAmount = 5,
    InvalidState = 6,
    SlippageExceeded = 7,
    InsufficientBond = 8,
    InvalidOracleConfig = 9,
    InvalidLimit = 10,
    CouncilWindowActive = 11,
    TitleTooLong = 12,
    DescriptionTooLong = 13,
    InvalidUrl = 14,
    ChallengeWindowActive = 15,
    ChallengeWindowClosed = 16,
}

/// Default council dispute resolution window in seconds (72 hours).
pub const COUNCIL_WINDOW_SECS: u64 = 72 * 60 * 60;

/// Maximum allowed length (in bytes) for a market title.
pub const MAX_TITLE_LEN: u32 = 160;
/// Maximum allowed length (in bytes) for a market description.
pub const MAX_DESCRIPTION_LEN: u32 = 1000;
/// Maximum allowed length (in bytes) for a source URL.
pub const MAX_URL_LEN: u32 = 2048;

/// An outcome awaiting its challenge window. The submitter's bond stays in
/// escrow until `finalize_outcome` returns it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Submission {
    pub submitter: Address,
    pub yes: bool,
    pub bond: i128,
    /// Last ledger sequence on which the outcome can still be challenged.
    pub challenge_deadline: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRecord {
    pub challenger: Address,
    pub bond: i128,
    pub council_deadline: u64,
}

const MAX_BETTOR_PAGE_SIZE: u32 = 100;
const XLM: i128 = 10_000_000;
const DEFAULT_SUBMITTER_BOND: i128 = 100 * XLM;
const DEFAULT_DISPUTER_BOND: i128 = 200 * XLM;
#[cfg(test)]
const BASE_BOND: i128 = DEFAULT_SUBMITTER_BOND;
#[cfg(test)]
const BASE_CHALLENGE_BOND: i128 = DEFAULT_DISPUTER_BOND;
const MIN_BASE_BOND: i128 = XLM;
const MAX_BASE_BOND: i128 = 1_000_000 * XLM;
const BOND_BPS: i128 = 100;
const BPS_DENOMINATOR: i128 = 10_000;
const DEFAULT_CHALLENGE_WINDOW_LEDGERS: u32 = 43_200;
const MIN_CHALLENGE_WINDOW_LEDGERS: u32 = 1;
const MAX_CHALLENGE_WINDOW_LEDGERS: u32 = 1_000_000;
const MAX_FEE_SHARE_BPS: u32 = 10_000;

/// Single-field market state replacing the separate
/// `resolved` / `cancelled` / `outcome` / `disputed` flags.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarketStatus {
    Open,
    ResolvedYes,
    ResolvedNo,
    Disputed,
    Cancelled,
    /// Outcome submitted; challengeable until `Submission::challenge_deadline`.
    Submitted,
}

#[contracttype]
#[derive(Clone)]
pub struct Market {
    pub status: MarketStatus,
    pub yes_pool: i128,
    pub no_pool: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct BettorPage {
    pub bettors: soroban_sdk::Vec<Address>,
    pub next_cursor: Option<u32>,
}

/// Pre-packing layout, kept so existing active markets still deserialize.
#[contracttype]
#[derive(Clone)]
pub struct LegacyMarket {
    pub resolved: bool,
    pub cancelled: bool,
    pub outcome: bool,
    pub disputed: bool,
    pub yes_pool: i128,
    pub no_pool: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConfig {
    pub submitter_bond: i128,
    pub disputer_bond: i128,
    pub challenge_window_ledgers: u32,
    pub challenger_reward_bps: u32,
    pub juror_reward_bps: u32,
    pub treasury_fee_bps: u32,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    Registry,
    IsPaused,
    Market,
    LegacyMarket,
    OracleConfig,
    HasBet(Address),
    BettorCount,
    Bettor(u32),
    Dispute,
    Submission,
}

#[contract]
pub struct MarketContract;

fn admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised))
}

/// Requires the caller to be the admin account.
///
/// The admin is expected to be a Stellar multi-signature account configured
/// with a 3-of-5 signer set and `high` threshold. `require_auth` on the admin
/// address forces the Stellar ledger to satisfy that account's signer weights
/// and thresholds before this contract entry point can execute, so a single
/// key cannot authorize privileged operations on its own.
fn require_admin(env: &Env, caller: &Address) {
    caller.require_auth();
    if *caller != admin(env) {
        panic_with_error!(env, Error::Unauthorized);
    }
}

fn require_not_paused(env: &Env) {
    if env
        .storage()
        .instance()
        .get(&DataKey::IsPaused)
        .unwrap_or(false)
    {
        panic_with_error!(env, Error::ContractPaused);
    }
}

/// Rejects market titles longer than [`MAX_TITLE_LEN`] bytes.
pub fn validate_title(env: &Env, title: &String) {
    if title.len() > MAX_TITLE_LEN {
        panic_with_error!(env, Error::TitleTooLong);
    }
}

/// Rejects market descriptions longer than [`MAX_DESCRIPTION_LEN`] bytes.
pub fn validate_description(env: &Env, description: &String) {
    if description.len() > MAX_DESCRIPTION_LEN {
        panic_with_error!(env, Error::DescriptionTooLong);
    }
}

/// Rejects external evidence/source URLs that are not well-formed `http(s)` URLs
/// or are longer than [`MAX_URL_LEN`] bytes.
pub fn validate_url(env: &Env, url: &String) {
    let len = url.len();
    if len == 0 || len > MAX_URL_LEN {
        panic_with_error!(env, Error::InvalidUrl);
    }
    let mut buf = [0u8; MAX_URL_LEN as usize];
    let bytes = &mut buf[..len as usize];
    url.copy_into_slice(bytes);
    let scheme_len = if bytes.starts_with(b"https://") {
        8
    } else if bytes.starts_with(b"http://") {
        7
    } else {
        panic_with_error!(env, Error::InvalidUrl);
    };
    // Require at least one host character after the scheme, and reject
    // whitespace and control characters anywhere in the URL.
    if bytes.len() <= scheme_len || bytes.iter().any(|&b| b <= 0x20 || b == 0x7f) {
        panic_with_error!(env, Error::InvalidUrl);
    }
}

fn load_market(env: &Env) -> Market {
    if let Some(m) = env
        .storage()
        .persistent()
        .get::<_, Market>(&DataKey::Market)
    {
        return m;
    }
    let l: LegacyMarket = env
        .storage()
        .persistent()
        .get(&DataKey::LegacyMarket)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised));
    from_legacy(&l)
}

fn from_legacy(l: &LegacyMarket) -> Market {
    let status = if l.cancelled {
        MarketStatus::Cancelled
    } else if l.disputed {
        MarketStatus::Disputed
    } else if l.resolved {
        if l.outcome {
            MarketStatus::ResolvedYes
        } else {
            MarketStatus::ResolvedNo
        }
    } else {
        MarketStatus::Open
    };
    Market {
        status,
        yes_pool: l.yes_pool,
        no_pool: l.no_pool,
    }
}

/// Current implied odds (in basis points, 0..=10_000) for the given side.
///
/// Odds are the share of the total pool backing the chosen side. An empty
/// pool yields 5_000 (50%) so the first bettor is not blocked by slippage.
fn current_odds(m: &Market, yes: bool) -> u32 {
    let total = m.yes_pool + m.no_pool;
    if total <= 0 {
        return 5_000;
    }
    let side = if yes { m.yes_pool } else { m.no_pool };
    ((side * 10_000) / total) as u32
}

fn default_oracle_config() -> OracleConfig {
    OracleConfig {
        submitter_bond: DEFAULT_SUBMITTER_BOND,
        disputer_bond: DEFAULT_DISPUTER_BOND,
        challenge_window_ledgers: DEFAULT_CHALLENGE_WINDOW_LEDGERS,
        challenger_reward_bps: 5_000,
        juror_reward_bps: 2_000,
        treasury_fee_bps: 3_000,
    }
}

fn load_oracle_config(env: &Env) -> OracleConfig {
    env.storage()
        .instance()
        .get(&DataKey::OracleConfig)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised))
}

fn valid_oracle_config(config: &OracleConfig) -> bool {
    config.submitter_bond >= MIN_BASE_BOND
        && config.submitter_bond <= MAX_BASE_BOND
        && config.disputer_bond >= MIN_BASE_BOND
        && config.disputer_bond <= MAX_BASE_BOND
        && config.challenge_window_ledgers >= MIN_CHALLENGE_WINDOW_LEDGERS
        && config.challenge_window_ledgers <= MAX_CHALLENGE_WINDOW_LEDGERS
        && config.challenger_reward_bps <= MAX_FEE_SHARE_BPS
        && config.juror_reward_bps <= MAX_FEE_SHARE_BPS
        && config.treasury_fee_bps <= MAX_FEE_SHARE_BPS
        && config.challenger_reward_bps as u64
            + config.juror_reward_bps as u64
            + config.treasury_fee_bps as u64
            == MAX_FEE_SHARE_BPS as u64
}

fn required_bond(pool: i128, base: i128) -> i128 {
    let scaled =
        (pool / BPS_DENOMINATOR) * BOND_BPS + (pool % BPS_DENOMINATOR) * BOND_BPS / BPS_DENOMINATOR;
    if scaled > base {
        scaled
    } else {
        base
    }
}

fn transfer_from_escrow(env: &Env, to: &Address, amount: i128) {
    if amount <= 0 {
        return;
    }
    let token: Address = env.storage().instance().get(&DataKey::Token).unwrap();
    env.invoke_contract::<()>(
        &token,
        &Symbol::new(env, "transfer"),
        vec![
            env,
            env.current_contract_address().to_val(),
            to.to_val(),
            amount.into_val(env),
        ],
    );
}

fn load_submission(env: &Env) -> Submission {
    env.storage()
        .persistent()
        .get(&DataKey::Submission)
        .unwrap_or_else(|| panic_with_error!(env, Error::InvalidState))
}

fn transfer_to_escrow(env: &Env, from: &Address, amount: i128) {
    let token: Address = env.storage().instance().get(&DataKey::Token).unwrap();
    env.invoke_contract::<()>(
        &token,
        &Symbol::new(env, "transfer"),
        vec![
            env,
            from.to_val(),
            env.current_contract_address().to_val(),
            amount.into_val(env),
        ],
    );
}

#[contractimpl]
impl MarketContract {
    pub fn init(env: Env, admin: Address, token: Address, registry: Option<Address>) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialised);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::OracleConfig, &default_oracle_config());
        if let Some(r) = registry {
            env.storage().instance().set(&DataKey::Registry, &r);
        }
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().persistent().set(
            &DataKey::Market,
            &Market {
                status: MarketStatus::Open,
                yes_pool: 0,
                no_pool: 0,
            },
        );
    }

    /// Validates market content (title, description, source URL) against the
    /// contract's length limits and URL format rules. Reverts on invalid input.
    pub fn validate_content(env: Env, title: String, description: String, source_url: String) {
        validate_title(&env, &title);
        validate_description(&env, &description);
        validate_url(&env, &source_url);
    }

    pub fn pause(env: Env, admin: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::IsPaused, &true);
    }

    pub fn unpause(env: Env, admin: Address) {
        require_admin(&env, &admin);
        env.storage().instance().set(&DataKey::IsPaused, &false);
    }

    pub fn set_oracle_config(env: Env, admin: Address, config: OracleConfig) {
        require_admin(&env, &admin);
        if !valid_oracle_config(&config) {
            panic_with_error!(&env, Error::InvalidOracleConfig);
        }
        env.storage()
            .instance()
            .set(&DataKey::OracleConfig, &config);
    }

    pub fn get_oracle_config(env: Env) -> OracleConfig {
        load_oracle_config(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    /// Rewrites a legacy flag-based market into the packed status form.
    pub fn migrate(env: Env, admin: Address) {
        require_admin(&env, &admin);
        let l: LegacyMarket = env
            .storage()
            .persistent()
            .get(&DataKey::LegacyMarket)
            .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidState));
        env.storage()
            .persistent()
            .set(&DataKey::Market, &from_legacy(&l));
        env.storage().persistent().remove(&DataKey::LegacyMarket);
    }

    /// Places a bet with slippage protection.
    ///
    /// `min_acceptable_odds` is the minimum implied odds (basis points, 0..=10_000)
    /// the bettor will accept for the chosen side. If the odds have shifted below
    /// this threshold (e.g. due to a sandwiching bet), the transaction reverts.
    pub fn place_bet(env: Env, bettor: Address, yes: bool, amount: i128, min_acceptable_odds: u32) {
        require_not_paused(&env);
        bettor.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut m = load_market(&env);
        if m.status != MarketStatus::Open {
            panic_with_error!(&env, Error::InvalidState);
        }
        if current_odds(&m, yes) < min_acceptable_odds {
            panic_with_error!(&env, Error::SlippageExceeded);
        }
        transfer_to_escrow(&env, &bettor, amount);
        if yes {
            m.yes_pool += amount
        } else {
            m.no_pool += amount
        }
        env.storage().persistent().set(&DataKey::Market, &m);

        let first = !env
            .storage()
            .persistent()
            .has(&DataKey::HasBet(bettor.clone()));
        if first {
            env.storage()
                .persistent()
                .set(&DataKey::HasBet(bettor.clone()), &true);
            let count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::BettorCount)
                .unwrap_or(0);
            let next_count = count
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidState));
            env.storage()
                .persistent()
                .set(&DataKey::Bettor(count), &bettor);
            env.storage()
                .persistent()
                .set(&DataKey::BettorCount, &next_count);
            if let Some(reg) = env
                .storage()
                .instance()
                .get::<_, Address>(&DataKey::Registry)
            {
                env.invoke_contract::<()>(
                    &reg,
                    &Symbol::new(&env, "record_first_bet"),
                    vec![
                        &env,
                        env.current_contract_address().to_val(),
                        bettor.to_val(),
                    ],
                );
            }
        }
    }

    /// Returns at most 100 bettors, starting at `cursor`; use `next_cursor` to fetch the next page.
    pub fn get_market_bettors(env: Env, cursor: u32, limit: u32) -> BettorPage {
        if limit == 0 || limit > MAX_BETTOR_PAGE_SIZE {
            panic_with_error!(&env, Error::InvalidLimit);
        }

        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::BettorCount)
            .unwrap_or(0);
        let end = cursor.saturating_add(limit).min(count);
        let mut bettors = soroban_sdk::Vec::new(&env);
        let mut index = cursor;
        while index < end {
            let bettor: Address = env
                .storage()
                .persistent()
                .get(&DataKey::Bettor(index))
                .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidState));
            bettors.push_back(bettor);
            index += 1;
        }

        BettorPage {
            bettors,
            next_cursor: if end < count { Some(end) } else { None },
        }
    }

    pub fn submit_outcome(env: Env, admin: Address, yes: bool, bond: i128) {
        require_not_paused(&env);
        require_admin(&env, &admin);
        let mut m = load_market(&env);
        if m.status != MarketStatus::Open {
            panic_with_error!(&env, Error::InvalidState);
        }
        let config = load_oracle_config(&env);
        if bond < required_bond(m.yes_pool + m.no_pool, config.submitter_bond) {
            panic_with_error!(&env, Error::InsufficientBond);
        }
        transfer_to_escrow(&env, &admin, bond);
        let challenge_deadline = env
            .ledger()
            .sequence()
            .saturating_add(config.challenge_window_ledgers);
        env.storage().persistent().set(
            &DataKey::Submission,
            &Submission {
                submitter: admin,
                yes,
                bond,
                challenge_deadline,
            },
        );
        m.status = MarketStatus::Submitted;
        env.storage().persistent().set(&DataKey::Market, &m);
    }

    pub fn challenge_outcome(env: Env, challenger: Address, bond: i128) {
        require_not_paused(&env);
        challenger.require_auth();
        let mut m = load_market(&env);
        if m.status != MarketStatus::Submitted {
            panic_with_error!(&env, Error::InvalidState);
        }
        if env.ledger().sequence() > load_submission(&env).challenge_deadline {
            panic_with_error!(&env, Error::ChallengeWindowClosed);
        }
        let config = load_oracle_config(&env);
        if bond < required_bond(m.yes_pool + m.no_pool, config.disputer_bond) {
            panic_with_error!(&env, Error::InsufficientBond);
        }
        transfer_to_escrow(&env, &challenger, bond);
        m.status = MarketStatus::Disputed;
        env.storage().persistent().set(&DataKey::Market, &m);
        let council_deadline = env.ledger().timestamp() + COUNCIL_WINDOW_SECS;
        env.storage().persistent().set(
            &DataKey::Dispute,
            &DisputeRecord {
                challenger,
                bond,
                council_deadline,
            },
        );
    }

    /// Permissionless escape hatch executable strictly after `council_deadline`.
    /// Cancels the stalled disputed market and refunds any escrowed bond in full.
    pub fn expire_council_dispute(env: Env) -> MarketStatus {
        require_not_paused(&env);
        let mut m = load_market(&env);
        if m.status != MarketStatus::Disputed {
            panic_with_error!(&env, Error::InvalidState);
        }
        let dispute: DisputeRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Dispute)
            .unwrap_or_else(|| panic_with_error!(&env, Error::InvalidState));
        if env.ledger().timestamp() <= dispute.council_deadline {
            panic_with_error!(&env, Error::CouncilWindowActive);
        }
        transfer_from_escrow(&env, &dispute.challenger, dispute.bond);
        if let Some(submission) = env
            .storage()
            .persistent()
            .get::<_, Submission>(&DataKey::Submission)
        {
            transfer_from_escrow(&env, &submission.submitter, submission.bond);
            env.storage().persistent().remove(&DataKey::Submission);
        }
        env.storage().persistent().remove(&DataKey::Dispute);
        m.status = MarketStatus::Cancelled;
        env.storage().persistent().set(&DataKey::Market, &m);
        m.status
    }

    /// Permissionless: once the challenge window has passed without a
    /// challenge, resolve the market to the submitted outcome and return the
    /// submitter's bond.
    pub fn finalize_outcome(env: Env) -> MarketStatus {
        require_not_paused(&env);
        let mut m = load_market(&env);
        if m.status != MarketStatus::Submitted {
            panic_with_error!(&env, Error::InvalidState);
        }
        let submission = load_submission(&env);
        if env.ledger().sequence() <= submission.challenge_deadline {
            panic_with_error!(&env, Error::ChallengeWindowActive);
        }
        m.status = if submission.yes {
            MarketStatus::ResolvedYes
        } else {
            MarketStatus::ResolvedNo
        };
        env.storage().persistent().set(&DataKey::Market, &m);
        env.storage().persistent().remove(&DataKey::Submission);
        transfer_from_escrow(&env, &submission.submitter, submission.bond);
        env.events().publish(
            (Symbol::new(&env, "oracle_finalized"),),
            (submission.submitter, submission.yes, submission.bond),
        );
        m.status
    }

    pub fn get_submission(env: Env) -> Option<Submission> {
        env.storage().persistent().get(&DataKey::Submission)
    }

    pub fn required_bond(env: Env, challenge: bool) -> i128 {
        let m = load_market(&env);
        let config = load_oracle_config(&env);
        let base = if challenge {
            config.disputer_bond
        } else {
            config.submitter_bond
        };
        required_bond(m.yes_pool + m.no_pool, base)
    }

    pub fn get_market(env: Env) -> Market {
        load_market(&env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    fn setup() -> (Env, MarketContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        // Keep entries live across a full challenge window, as mainnet's
        // minimum TTLs do.
        env.ledger().with_mut(|l| {
            l.min_persistent_entry_ttl = 1_000_000;
            l.min_temp_entry_ttl = 1_000_000;
            l.max_entry_ttl = 2_000_000;
        });
        let id = env.register_contract(None, MarketContract);
        let c = MarketContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&admin, &BASE_BOND);
        c.init(&admin, &token, &None);
        (env, c, admin, token)
    }

    #[test]
    fn pause_blocks_mutations_not_reads() {
        let (env, c, admin, _) = setup();
        c.pause(&admin);
        assert!(c.is_paused());
        assert_eq!(
            c.try_submit_outcome(&admin, &true, &BASE_BOND),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::ContractPaused as u32
            )))
        );
        assert_eq!(
            c.try_challenge_outcome(&Address::generate(&env), &BASE_CHALLENGE_BOND),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::ContractPaused as u32
            )))
        );
        assert_eq!(
            c.try_place_bet(&Address::generate(&env), &true, &1, &0),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::ContractPaused as u32
            )))
        );

        assert_eq!(c.get_market().status, MarketStatus::Open);
        c.unpause(&admin);
        c.submit_outcome(&admin, &true, &BASE_BOND);
        assert_eq!(c.get_market().status, MarketStatus::Submitted);
    }

    #[test]
    fn legacy_market_migrates() {
        let (env, c, admin, _) = setup();
        env.as_contract(&c.address, || {
            env.storage().persistent().set(
                &DataKey::LegacyMarket,
                &LegacyMarket {
                    resolved: true,
                    cancelled: false,
                    outcome: true,
                    disputed: false,
                    yes_pool: 10,
                    no_pool: 5,
                },
            );
            env.storage().persistent().remove(&DataKey::Market);
        });
        c.migrate(&admin);
        let m = c.get_market();
        assert_eq!(m.status, MarketStatus::ResolvedYes);
        assert_eq!(m.yes_pool, 10);
        assert_eq!(m.no_pool, 5);
    }

    #[test]
    fn place_bet_reverts_when_odds_below_threshold() {
        let (env, c, _admin, token) = setup();
        let bettor = || {
            let a = Address::generate(&env);
            soroban_sdk::token::StellarAssetClient::new(&env, &token).mint(&a, &100);
            a
        };
        // Seed the pool so yes odds are 50% (5_000 bps).
        c.place_bet(&bettor(), &true, &100, &0);
        c.place_bet(&bettor(), &false, &100, &0);
        // Requiring 60% odds must revert since current odds are 50%.
        assert_eq!(
            c.try_place_bet(&bettor(), &true, &10, &6_000),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::SlippageExceeded as u32
            )))
        );
        // Requiring 50% odds succeeds.
        c.place_bet(&bettor(), &true, &10, &5_000);
    }

    #[test]
    fn oracle_config_updates_bond_requirements() {
        use soroban_sdk::token::StellarAssetClient;

        let (env, c, admin, token) = setup();
        let mut config = c.get_oracle_config();
        config.submitter_bond = 150 * XLM;
        config.disputer_bond = 250 * XLM;
        config.challenge_window_ledgers = 50_000;
        config.challenger_reward_bps = 6_000;
        config.juror_reward_bps = 1_000;
        config.treasury_fee_bps = 3_000;
        c.set_oracle_config(&admin, &config);

        assert_eq!(c.get_oracle_config(), config);
        assert_eq!(c.required_bond(&false), 150 * XLM);
        assert_eq!(c.required_bond(&true), 250 * XLM);

        StellarAssetClient::new(&env, &token).mint(&admin, &(50 * XLM));
        assert_eq!(
            c.try_submit_outcome(&admin, &true, &(150 * XLM - 1)),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::InsufficientBond as u32
            )))
        );
        c.submit_outcome(&admin, &true, &(150 * XLM));
        let disputer = Address::generate(&env);
        StellarAssetClient::new(&env, &token).mint(&disputer, &(250 * XLM));
        assert_eq!(
            c.try_challenge_outcome(&disputer, &(250 * XLM - 1)),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::InsufficientBond as u32
            )))
        );
        c.challenge_outcome(&disputer, &(250 * XLM));
        assert_eq!(c.get_market().status, MarketStatus::Disputed);
    }

    #[test]
    fn oracle_config_requires_admin_and_valid_bounds() {
        let (env, c, admin, _) = setup();
        let mut config = c.get_oracle_config();

        config.submitter_bond = XLM - 1;
        assert_eq!(
            c.try_set_oracle_config(&admin, &config),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::InvalidOracleConfig as u32
            )))
        );

        config = c.get_oracle_config();
        config.disputer_bond = MAX_BASE_BOND + 1;
        assert_eq!(
            c.try_set_oracle_config(&admin, &config),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::InvalidOracleConfig as u32
            )))
        );

        config = c.get_oracle_config();
        config.challenge_window_ledgers = MAX_CHALLENGE_WINDOW_LEDGERS + 1;
        assert_eq!(
            c.try_set_oracle_config(&admin, &config),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::InvalidOracleConfig as u32
            )))
        );

        config = c.get_oracle_config();
        config.treasury_fee_bps -= 1;
        assert_eq!(
            c.try_set_oracle_config(&admin, &config),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::InvalidOracleConfig as u32
            )))
        );

        let non_admin = Address::generate(&env);
        assert_eq!(
            c.try_set_oracle_config(&non_admin, &c.get_oracle_config()),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::Unauthorized as u32
            )))
        );
    }

    #[test]
    fn validate_content_accepts_valid_input() {
        let (env, c, _admin, _) = setup();
        let title = String::from_str(&env, "Will BTC close above $100k?");
        let desc = String::from_str(
            &env,
            "Resolves YES if BTC/USD closes above 100000 on 2025-12-31.",
        );
        let url = String::from_str(&env, "https://example.com/evidence");
        c.validate_content(&title, &desc, &url);
    }

    #[test]
    fn validate_content_rejects_oversized_title() {
        let (env, c, _admin, _) = setup();
        let long = "a".repeat((MAX_TITLE_LEN + 1) as usize);
        let title = String::from_str(&env, &long);
        let desc = String::from_str(&env, "ok");
        let url = String::from_str(&env, "https://example.com");
        assert_eq!(
            c.try_validate_content(&title, &desc, &url),
            Err(Ok(soroban_sdk::Error::from_contract_error(
                Error::TitleTooLong as u32
            )))
        );
    }

    fn err(e: Error) -> Result<soroban_sdk::Error, soroban_sdk::InvokeError> {
        Ok(soroban_sdk::Error::from_contract_error(e as u32))
    }

    fn advance_ledgers(env: &Env, n: u32) {
        env.ledger().with_mut(|l| l.sequence_number += n);
    }

    #[test]
    fn uncontested_outcome_finalizes_after_window_and_returns_bond() {
        let (env, c, admin, token) = setup();
        let balance = soroban_sdk::token::Client::new(&env, &token);
        c.submit_outcome(&admin, &false, &BASE_BOND);
        assert_eq!(balance.balance(&admin), 0);
        let window = c.get_oracle_config().challenge_window_ledgers;
        let submission = c.get_submission().unwrap();
        assert_eq!(
            submission.challenge_deadline,
            env.ledger().sequence() + window
        );

        advance_ledgers(&env, window);
        assert_eq!(
            c.try_finalize_outcome().unwrap_err(),
            err(Error::ChallengeWindowActive)
        );

        advance_ledgers(&env, 1);
        assert_eq!(c.finalize_outcome(), MarketStatus::ResolvedNo);
        assert_eq!(c.get_market().status, MarketStatus::ResolvedNo);
        assert_eq!(balance.balance(&admin), BASE_BOND);
        assert_eq!(balance.balance(&c.address), 0);
        assert_eq!(c.get_submission(), None);
        // Finalizing twice cannot pay the bond out twice.
        assert_eq!(
            c.try_finalize_outcome().unwrap_err(),
            err(Error::InvalidState)
        );
    }

    #[test]
    fn challenge_closes_with_window_and_blocks_finalization() {
        let (env, c, admin, token) = setup();
        c.submit_outcome(&admin, &true, &BASE_BOND);
        let challenger = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token)
            .mint(&challenger, &BASE_CHALLENGE_BOND);
        c.challenge_outcome(&challenger, &BASE_CHALLENGE_BOND);
        assert_eq!(c.get_market().status, MarketStatus::Disputed);

        advance_ledgers(&env, c.get_oracle_config().challenge_window_ledgers + 1);
        assert_eq!(
            c.try_finalize_outcome().unwrap_err(),
            err(Error::InvalidState)
        );
    }

    #[test]
    fn challenge_rejected_after_window() {
        let (env, c, admin, token) = setup();
        c.submit_outcome(&admin, &true, &BASE_BOND);
        let challenger = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token)
            .mint(&challenger, &BASE_CHALLENGE_BOND);
        advance_ledgers(&env, c.get_oracle_config().challenge_window_ledgers + 1);
        assert_eq!(
            c.try_challenge_outcome(&challenger, &BASE_CHALLENGE_BOND)
                .unwrap_err(),
            err(Error::ChallengeWindowClosed)
        );
    }

    #[test]
    fn expired_council_dispute_refunds_both_bonds() {
        let (env, c, admin, token) = setup();
        let balance = soroban_sdk::token::Client::new(&env, &token);
        c.submit_outcome(&admin, &true, &BASE_BOND);
        let challenger = Address::generate(&env);
        soroban_sdk::token::StellarAssetClient::new(&env, &token)
            .mint(&challenger, &BASE_CHALLENGE_BOND);
        c.challenge_outcome(&challenger, &BASE_CHALLENGE_BOND);

        env.ledger()
            .with_mut(|l| l.timestamp += COUNCIL_WINDOW_SECS + 1);
        assert_eq!(c.expire_council_dispute(), MarketStatus::Cancelled);
        assert_eq!(balance.balance(&admin), BASE_BOND);
        assert_eq!(balance.balance(&challenger), BASE_CHALLENGE_BOND);
        assert_eq!(balance.balance(&c.address), 0);
    }

    #[test]
    fn finalize_outcome_requires_submission_and_unpaused() {
        let (env, c, admin, _) = setup();
        assert_eq!(
            c.try_finalize_outcome().unwrap_err(),
            err(Error::InvalidState)
        );
        c.submit_outcome(&admin, &true, &BASE_BOND);
        advance_ledgers(&env, c.get_oracle_config().challenge_window_ledgers + 1);
        c.pause(&admin);
        assert_eq!(
            c.try_finalize_outcome().unwrap_err(),
            err(Error::ContractPaused)
        );
        c.unpause(&admin);
        assert_eq!(c.finalize_outcome(), MarketStatus::ResolvedYes);
    }
}
