#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Map,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialised = 1,
    NotInitialised = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InsufficientBalance = 5,
}

#[contracttype]
pub enum DataKey {
    Admin,
    AuthorizedMinters,
    TotalSupply,
    Balance(Address),
}

#[contract]
pub struct IPredictToken;

fn admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised))
}

fn minters(env: &Env) -> Map<Address, bool> {
    env.storage()
        .instance()
        .get(&DataKey::AuthorizedMinters)
        .unwrap_or_else(|| Map::new(env))
}

fn balance_of(env: &Env, who: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(who.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, who: &Address, amount: i128) {
    env.storage().persistent().set(&DataKey::Balance(who.clone()), &amount);
}

#[contractimpl]
impl IPredictToken {
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialised);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
    }

    pub fn add_minter(env: Env, admin_addr: Address, minter: Address) {
        admin_addr.require_auth();
        if admin_addr != admin(&env) {
            panic_with_error!(&env, Error::Unauthorized);
        }
        let mut m = minters(&env);
        m.set(minter, true);
        env.storage().instance().set(&DataKey::AuthorizedMinters, &m);
    }

    pub fn remove_minter(env: Env, admin_addr: Address, minter: Address) {
        admin_addr.require_auth();
        if admin_addr != admin(&env) {
            panic_with_error!(&env, Error::Unauthorized);
        }
        let mut m = minters(&env);
        m.remove(minter);
        env.storage().instance().set(&DataKey::AuthorizedMinters, &m);
    }

    pub fn is_minter(env: Env, address: Address) -> bool {
        minters(&env).get(address).unwrap_or(false)
    }

    pub fn mint(env: Env, caller: Address, to: Address, amount: i128) {
        caller.require_auth();
        if !minters(&env).get(caller).unwrap_or(false) {
            panic_with_error!(&env, Error::Unauthorized);
        }
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        set_balance(&env, &to, balance_of(&env, &to) + amount);
        let supply: i128 = env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0);
        env.storage().instance().set(&DataKey::TotalSupply, &(supply + amount));
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let bal = balance_of(&env, &from);
        if bal < amount {
            panic_with_error!(&env, Error::InsufficientBalance);
        }
        set_balance(&env, &from, bal - amount);
        set_balance(&env, &to, balance_of(&env, &to) + amount);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        balance_of(&env, &id)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalSupply).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, IPredictTokenClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, IPredictToken);
        let client = IPredictTokenClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.init(&admin);
        (env, client, admin)
    }

    #[test]
    fn multiple_minters_and_revocation() {
        let (env, c, admin) = setup();
        let (m1, m2, to) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
        c.add_minter(&admin, &m1);
        c.add_minter(&admin, &m2);
        c.mint(&m1, &to, &5);
        c.mint(&m2, &to, &7);
        assert_eq!(c.balance(&to), 12);
        c.remove_minter(&admin, &m1);
        assert!(c.try_mint(&m1, &to, &1).is_err());
        c.mint(&m2, &to, &1);
        assert_eq!(c.total_supply(), 13);
    }

    #[test]
    fn non_admin_cannot_add_minter() {
        let (env, c, _) = setup();
        let other = Address::generate(&env);
        assert!(c.try_add_minter(&other, &other).is_err());
    }
}
