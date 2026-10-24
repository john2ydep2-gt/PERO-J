#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, vec, Address, Env,
    IntoVal, Symbol,
};

const WELCOME_POINTS: u32 = 5;
const WELCOME_TOKENS: i128 = 10_000_000; // 1 IPREDICT (7 decimals)

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    Unauthorized = 3,
    AlreadyRegistered = 4,
    NotRegistered = 5,
    InsufficientBalance = 6,
    CooldownActive = 7,
    NoBetPlaced = 8,
    AlreadyClaimed = 9,
    SelfReferral = 10,
}

#[contracttype]
#[derive(Clone)]
pub struct Registration {
    pub referrer: Option<Address>,
    pub registered_at: u64,
    pub has_bet: bool,
    pub claimed: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    Market,
    BalanceToken,
    MinBalance,
    Cooldown,
    Registration(Address),
    Points(Address),
}

#[contract]
pub struct ReferralRegistry;

fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, k: &DataKey) -> T {
    env.storage()
        .instance()
        .get(k)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised))
}

#[contractimpl]
impl ReferralRegistry {
    /// `balance_token` is the XLM (native) token contract used for the
    /// minimum-balance check; `token` is IPREDICT; `market` reports first bets.
    pub fn init(
        env: Env,
        admin: Address,
        token: Address,
        market: Address,
        balance_token: Address,
        min_balance: i128,
        cooldown_secs: u64,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialised);
        }
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Token, &token);
        s.set(&DataKey::Market, &market);
        s.set(&DataKey::BalanceToken, &balance_token);
        s.set(&DataKey::MinBalance, &min_balance);
        s.set(&DataKey::Cooldown, &cooldown_secs);
    }

    /// Registration requires a non-zero (>= min) XLM balance. No reward is paid here.
    pub fn register(env: Env, user: Address, referrer: Option<Address>) {
        user.require_auth();
        if referrer.as_ref() == Some(&user) {
            panic_with_error!(&env, Error::SelfReferral);
        }
        let key = DataKey::Registration(user.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::AlreadyRegistered);
        }
        let bal_token: Address = get(&env, &DataKey::BalanceToken);
        let min: i128 = get(&env, &DataKey::MinBalance);
        let bal: i128 = env.invoke_contract(
            &bal_token,
            &Symbol::new(&env, "balance"),
            vec![&env, user.to_val()],
        );
        if bal <= 0 || bal < min {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        env.storage().persistent().set(
            &key,
            &Registration {
                referrer,
                registered_at: env.ledger().timestamp(),
                has_bet: false,
                claimed: false,
            },
        );
    }

    /// Called by the market contract when `user` places their first bet.
    pub fn record_first_bet(env: Env, caller: Address, user: Address) {
        caller.require_auth();
        if caller != get::<Address>(&env, &DataKey::Market) {
            panic_with_error!(&env, Error::Unauthorized);
        }
        let key = DataKey::Registration(user);
        if let Some(mut r) = env.storage().persistent().get::<_, Registration>(&key) {
            r.has_bet = true;
            env.storage().persistent().set(&key, &r);
        }
    }

    /// Pays the welcome bonus once the user has bet and the cooldown has elapsed.
    pub fn claim_welcome_bonus(env: Env, user: Address) {
        user.require_auth();
        let key = DataKey::Registration(user.clone());
        let mut r: Registration = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotRegistered));
        if r.claimed {
            panic_with_error!(&env, Error::AlreadyClaimed);
        }
        if !r.has_bet {
            panic_with_error!(&env, Error::NoBetPlaced);
        }
        let cooldown: u64 = get(&env, &DataKey::Cooldown);
        if env.ledger().timestamp() < r.registered_at + cooldown {
            panic_with_error!(&env, Error::CooldownActive);
        }
        r.claimed = true;
        env.storage().persistent().set(&key, &r);

        let pk = DataKey::Points(user.clone());
        let pts: u32 = env.storage().persistent().get(&pk).unwrap_or(0);
        env.storage().persistent().set(&pk, &(pts + WELCOME_POINTS));

        let token: Address = get(&env, &DataKey::Token);
        env.invoke_contract::<()>(
            &token,
            &Symbol::new(&env, "mint"),
            vec![
                &env,
                env.current_contract_address().to_val(),
                user.to_val(),
                WELCOME_TOKENS.into_val(&env),
            ],
        );
    }

    pub fn get_registration(env: Env, user: Address) -> Option<Registration> {
        env.storage().persistent().get(&DataKey::Registration(user))
    }

    pub fn get_points(env: Env, user: Address) -> u32 {
        env.storage().persistent().get(&DataKey::Points(user)).unwrap_or(0)
    }
}
