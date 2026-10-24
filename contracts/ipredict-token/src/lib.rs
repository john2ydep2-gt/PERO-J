#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env,
    panic_with_error,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized      = 1,
    AlreadyInitialized  = 2,
    InvalidAmount       = 3,
    InsufficientBalance = 4,
}

#[contracttype]
pub enum DataKey {
    Admin,
    TotalSupply,
    Balance(Address),
}

#[contract]
pub struct IPredictToken;

fn balance_of(env: &Env, who: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::Balance(who.clone())).unwrap_or(0)
}

fn total_supply(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0)
}

#[contractimpl]
impl IPredictToken {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
        admin.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        env.storage().persistent().set(&DataKey::Balance(to.clone()), &(balance_of(&env, &to) + amount));
        env.storage().instance().set(&DataKey::TotalSupply, &(total_supply(&env) + amount));
        env.events().publish((symbol_short!("token"), symbol_short!("minted")), (to, amount));
    }

    /// Burn `amount` of `caller`'s own tokens, reducing `total_supply` atomically.
    /// Reverts if `amount` is not positive or exceeds the caller's balance.
    pub fn burn(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let bal = balance_of(&env, &caller);
        if bal < amount {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        env.storage().persistent().set(&DataKey::Balance(caller.clone()), &(bal - amount));
        env.storage().instance().set(&DataKey::TotalSupply, &(total_supply(&env) - amount));
        env.events().publish((symbol_short!("token"), symbol_short!("burned")), (caller, amount));
    }

    pub fn balance(env: Env, who: Address) -> i128 {
        balance_of(&env, &who)
    }

    pub fn total_supply(env: Env) -> i128 {
        total_supply(&env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, IPredictTokenClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IPredictToken);
        let c = IPredictTokenClient::new(&env, &id);
        c.initialize(&Address::generate(&env));
        let user = Address::generate(&env);
        c.mint(&user, &100);
        (env, c, user)
    }

    #[test]
    fn burn_reduces_balance_and_supply() {
        let (_e, c, user) = setup();
        c.burn(&user, &40);
        assert_eq!(c.balance(&user), 60);
        assert_eq!(c.total_supply(), 60);
    }

    #[test]
    fn burn_more_than_balance_reverts() {
        let (_e, c, user) = setup();
        assert!(c.try_burn(&user, &101).is_err());
        assert_eq!(c.total_supply(), 100);
    }

    #[test]
    fn burn_zero_reverts() {
        let (_e, c, user) = setup();
        assert!(c.try_burn(&user, &0).is_err());
    }
}
