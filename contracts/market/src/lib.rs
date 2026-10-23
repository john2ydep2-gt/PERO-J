#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, Env, Symbol, Vec,
};

soroban_sdk::contractmeta!(key = "name", val = "PERO-J-market");
soroban_sdk::contractmeta!(key = "version", val = "0.1.0");

// ── Error codes ──────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    MarketNotFound = 4,
    MarketExists = 5,
    InvalidState = 6,
    InvalidSide = 7,
    InvalidAmount = 8,
    InsufficientBond = 9,
    NothingToClaim = 10,
    AlreadyClaimed = 11,
    TimelockActive = 12,
    ThresholdNotReached = 13,
    AlreadyVoted = 14,
    NotCouncil = 15,
    InsufficientFees = 16,
}

// ── Protocol parameters ──────────────────────────────────────────────────────
/// Protocol fee taken from the total pool when a market resolves (2%).
const FEE_BPS: i128 = 200;
/// Minimum submitter bond: 100 XLM in stroops.
pub const BASE_BOND: i128 = 100 * 10_000_000;
/// Minimum disputer bond: 200 XLM in stroops.
pub const BASE_CHALLENGE_BOND: i128 = 200 * 10_000_000;
/// Bonds scale with the pool: bond >= pool * BOND_BPS / 10_000 (1%).
pub const BOND_BPS: i128 = 100;
/// Delay between the council reaching quorum and `finalize_dispute` (12h).
pub const TIMELOCK_SECS: u64 = 12 * 60 * 60;

// ── Types ────────────────────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Open,
    Resolved,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub side: u32,
    pub submitter: Address,
    pub bond: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Dispute {
    pub disputer: Address,
    pub bond: i128,
    pub votes: Vec<u32>,
    pub voters: Vec<Address>,
    /// Side that reached quorum; meaningful only when `threshold_reached_at > 0`.
    pub side: u32,
    pub threshold_reached_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    pub status: Status,
    /// Pool staked on NO (side 0) and YES (side 1).
    pub pool_no: i128,
    pub pool_yes: i128,
    pub winning_side: u32,
    /// Pool distributed to winners (total minus protocol fee).
    pub payout_pool: i128,
}

#[contracttype]
enum DataKey {
    Admin,
    Token,
    Fees,
    Council,
    Quorum,
    Market(u64),
    Proposal(u64),
    Dispute(u64),
    Bet(u64, Address, u32),
    Claimed(u64, Address),
}

// ── Events ───────────────────────────────────────────────────────────────────
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutClaimedEvent {
    pub market_id: u64,
    pub user: Address,
    pub amount: i128,
    pub token_payout: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeesWithdrawnEvent {
    pub admin: Address,
    pub token: Address,
    pub amount: i128,
    pub timestamp: u64,
}

// ── Helpers ──────────────────────────────────────────────────────────────────
fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey) -> T {
    env.storage()
        .instance()
        .get(key)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

fn require_admin(env: &Env, caller: &Address) {
    let admin: Address = get(env, &DataKey::Admin);
    if *caller != admin {
        panic_with_error!(env, Error::Unauthorized);
    }
    caller.require_auth();
}

fn load_market(env: &Env, id: u64) -> Market {
    env.storage()
        .persistent()
        .get(&DataKey::Market(id))
        .unwrap_or_else(|| panic_with_error!(env, Error::MarketNotFound))
}

fn save_market(env: &Env, id: u64, m: &Market) {
    env.storage().persistent().set(&DataKey::Market(id), m);
}

fn proposal_of(env: &Env, id: u64) -> Option<Proposal> {
    env.storage().persistent().get(&DataKey::Proposal(id))
}

fn dispute_of(env: &Env, id: u64) -> Option<Dispute> {
    env.storage().persistent().get(&DataKey::Dispute(id))
}

fn save_dispute(env: &Env, id: u64, d: &Dispute) {
    env.storage().persistent().set(&DataKey::Dispute(id), d);
}

fn token_client(env: &Env) -> token::Client<'_> {
    token::Client::new(env, &get::<Address>(env, &DataKey::Token))
}

fn bond_for(pool: i128, base: i128) -> i128 {
    let scaled = pool * BOND_BPS / 10_000;
    if scaled > base {
        scaled
    } else {
        base
    }
}

fn add_fees(env: &Env, amount: i128) {
    let fees: i128 = env.storage().instance().get(&DataKey::Fees).unwrap_or(0);
    env.storage()
        .instance()
        .set(&DataKey::Fees, &(fees + amount));
}

/// Resolves `m` to `side`. A resolution whose winning side holds no stake while
/// the pool is non-empty would lock every deposit, so the market is cancelled
/// and all stakes (and bonds) become refundable instead.
fn settle(env: &Env, id: u64, m: &mut Market, side: u32) {
    let total = m.pool_no + m.pool_yes;
    let winning_pool = if side == 1 { m.pool_yes } else { m.pool_no };
    let cancelled = total > 0 && winning_pool == 0;
    m.winning_side = side;
    if cancelled {
        m.status = Status::Cancelled;
    } else {
        let fee = total * FEE_BPS / 10_000;
        m.status = Status::Resolved;
        m.payout_pool = total - fee;
        add_fees(env, fee);
    }

    // Bond rules: the side proven right gets its bond back, the other forfeits
    // it to the protocol. A cancelled market refunds both.
    let tok = token_client(env);
    let me = env.current_contract_address();
    let settle_bond = |who: &Address, bond: i128, keep: bool| {
        if keep || cancelled {
            tok.transfer(&me, who, &bond);
        } else {
            add_fees(env, bond);
        }
    };
    let proposal = proposal_of(env, id);
    if let Some(p) = &proposal {
        settle_bond(&p.submitter, p.bond, p.side == side);
    }
    if let Some(d) = &dispute_of(env, id) {
        let proposed = proposal.as_ref().map(|p| p.side).unwrap_or(side);
        settle_bond(&d.disputer, d.bond, proposed != side);
    }
    save_market(env, id, m);
}

#[contract]
pub struct MarketContract;

#[contractimpl]
impl MarketContract {
    pub fn init(env: Env, admin: Address, token: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
    }

    pub fn set_council(env: Env, admin: Address, council: Vec<Address>, quorum: u32) {
        require_admin(&env, &admin);
        if quorum == 0 || quorum > council.len() {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::Council, &council);
        env.storage().instance().set(&DataKey::Quorum, &quorum);
    }

    pub fn create_market(env: Env, admin: Address, id: u64) {
        require_admin(&env, &admin);
        if env.storage().persistent().has(&DataKey::Market(id)) {
            panic_with_error!(&env, Error::MarketExists);
        }
        let m = Market {
            status: Status::Open,
            pool_no: 0,
            pool_yes: 0,
            winning_side: 0,
            payout_pool: 0,
        };
        save_market(&env, id, &m);
    }

    /// `side`: 0 = NO, 1 = YES.
    pub fn place_bet(env: Env, user: Address, id: u64, side: u32, amount: i128) {
        user.require_auth();
        if side > 1 {
            panic_with_error!(&env, Error::InvalidSide);
        }
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut m = load_market(&env, id);
        // Betting closes once an outcome is proposed so bonds cannot be undersized.
        if m.status != Status::Open || proposal_of(&env, id).is_some() {
            panic_with_error!(&env, Error::InvalidState);
        }
        token_client(&env).transfer(&user, &env.current_contract_address(), &amount);
        if side == 1 {
            m.pool_yes += amount;
        } else {
            m.pool_no += amount;
        }
        let key = DataKey::Bet(id, user, side);
        let prev: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(prev + amount));
        save_market(&env, id, &m);
    }

    /// Bond required to submit (or, with `challenge`, to dispute) an outcome:
    /// `max(base, pool * BOND_BPS / 10_000)`.
    pub fn required_bond(env: Env, id: u64, challenge: bool) -> i128 {
        let m = load_market(&env, id);
        let base = if challenge {
            BASE_CHALLENGE_BOND
        } else {
            BASE_BOND
        };
        bond_for(m.pool_no + m.pool_yes, base)
    }

    pub fn submit_outcome(env: Env, submitter: Address, id: u64, side: u32, bond: i128) {
        submitter.require_auth();
        if side > 1 {
            panic_with_error!(&env, Error::InvalidSide);
        }
        let m = load_market(&env, id);
        if m.status != Status::Open || proposal_of(&env, id).is_some() {
            panic_with_error!(&env, Error::InvalidState);
        }
        if bond < bond_for(m.pool_no + m.pool_yes, BASE_BOND) {
            panic_with_error!(&env, Error::InsufficientBond);
        }
        token_client(&env).transfer(&submitter, &env.current_contract_address(), &bond);
        env.storage().persistent().set(
            &DataKey::Proposal(id),
            &Proposal {
                side,
                submitter,
                bond,
            },
        );
    }

    pub fn challenge_outcome(env: Env, disputer: Address, id: u64, bond: i128) {
        disputer.require_auth();
        let m = load_market(&env, id);
        if m.status != Status::Open
            || proposal_of(&env, id).is_none()
            || dispute_of(&env, id).is_some()
        {
            panic_with_error!(&env, Error::InvalidState);
        }
        if bond < bond_for(m.pool_no + m.pool_yes, BASE_CHALLENGE_BOND) {
            panic_with_error!(&env, Error::InsufficientBond);
        }
        token_client(&env).transfer(&disputer, &env.current_contract_address(), &bond);
        let d = Dispute {
            disputer,
            bond,
            votes: Vec::from_array(&env, [0u32, 0u32]),
            voters: Vec::new(&env),
            side: 0,
            threshold_reached_at: 0,
        };
        save_dispute(&env, id, &d);
    }

    /// Council vote on a disputed market; records `threshold_reached_at` when a
    /// side reaches quorum, which starts the finalization timelock.
    pub fn vote_dispute(env: Env, member: Address, id: u64, side: u32) {
        member.require_auth();
        if side > 1 {
            panic_with_error!(&env, Error::InvalidSide);
        }
        let council: Vec<Address> = get(&env, &DataKey::Council);
        if !council.contains(&member) {
            panic_with_error!(&env, Error::NotCouncil);
        }
        let quorum: u32 = get(&env, &DataKey::Quorum);
        let m = load_market(&env, id);
        let mut d = match dispute_of(&env, id) {
            Some(d) if m.status == Status::Open && d.threshold_reached_at == 0 => d,
            _ => panic_with_error!(&env, Error::InvalidState),
        };
        if d.voters.contains(&member) {
            panic_with_error!(&env, Error::AlreadyVoted);
        }
        d.voters.push_back(member);
        let tally = d.votes.get(side).unwrap_or(0) + 1;
        d.votes.set(side, tally);
        if tally >= quorum {
            d.side = side;
            d.threshold_reached_at = env.ledger().timestamp();
        }
        save_dispute(&env, id, &d);
    }

    /// Emergency veto: admin resets the vote while the timelock is pending.
    pub fn veto_dispute(env: Env, admin: Address, id: u64) {
        require_admin(&env, &admin);
        let mut d = match dispute_of(&env, id) {
            Some(d) if d.threshold_reached_at > 0 => d,
            _ => panic_with_error!(&env, Error::ThresholdNotReached),
        };
        if env.ledger().timestamp() >= d.threshold_reached_at + TIMELOCK_SECS {
            panic_with_error!(&env, Error::InvalidState);
        }
        d.votes = Vec::from_array(&env, [0u32, 0u32]);
        d.voters = Vec::new(&env);
        d.threshold_reached_at = 0;
        save_dispute(&env, id, &d);
    }

    pub fn finalize_dispute(env: Env, id: u64) -> Status {
        let mut m = load_market(&env, id);
        let d = match dispute_of(&env, id) {
            Some(d) if m.status == Status::Open && d.threshold_reached_at > 0 => d,
            _ => panic_with_error!(&env, Error::ThresholdNotReached),
        };
        if env.ledger().timestamp() < d.threshold_reached_at + TIMELOCK_SECS {
            panic_with_error!(&env, Error::TimelockActive);
        }
        settle(&env, id, &mut m, d.side);
        m.status
    }

    /// Admin resolution. Returns `Cancelled` (refund path) when the winning
    /// side has no stake but the pool is non-empty.
    pub fn resolve_market(env: Env, admin: Address, id: u64, winning_side: u32) -> Status {
        require_admin(&env, &admin);
        if winning_side > 1 {
            panic_with_error!(&env, Error::InvalidSide);
        }
        let mut m = load_market(&env, id);
        if m.status != Status::Open {
            panic_with_error!(&env, Error::InvalidState);
        }
        settle(&env, id, &mut m, winning_side);
        m.status
    }

    /// Pays out winnings (or the full stake on a cancelled market).
    pub fn claim(env: Env, user: Address, id: u64) -> i128 {
        user.require_auth();
        let m = load_market(&env, id);
        let stake = |side: u32| -> i128 {
            env.storage()
                .persistent()
                .get(&DataKey::Bet(id, user.clone(), side))
                .unwrap_or(0)
        };
        let amount = match m.status {
            Status::Open => panic_with_error!(&env, Error::InvalidState),
            Status::Cancelled => stake(0) + stake(1),
            Status::Resolved => {
                let winning_pool = if m.winning_side == 1 {
                    m.pool_yes
                } else {
                    m.pool_no
                };
                if winning_pool == 0 {
                    0
                } else {
                    stake(m.winning_side) * m.payout_pool / winning_pool
                }
            }
        };
        if amount <= 0 {
            panic_with_error!(&env, Error::NothingToClaim);
        }
        let claimed = DataKey::Claimed(id, user.clone());
        if env.storage().persistent().has(&claimed) {
            panic_with_error!(&env, Error::AlreadyClaimed);
        }
        env.storage().persistent().set(&claimed, &true);

        let token: Address = get(&env, &DataKey::Token);
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &user, &amount);
        env.events().publish(
            (symbol_short!("mkt"), symbol_short!("claimed")),
            PayoutClaimedEvent {
                market_id: id,
                user,
                amount,
                token_payout: token,
            },
        );
        amount
    }

    pub fn withdraw_fees(env: Env, admin: Address, amount: i128) {
        require_admin(&env, &admin);
        let fees: i128 = env.storage().instance().get(&DataKey::Fees).unwrap_or(0);
        if amount <= 0 || amount > fees {
            panic_with_error!(&env, Error::InsufficientFees);
        }
        env.storage()
            .instance()
            .set(&DataKey::Fees, &(fees - amount));
        let token: Address = get(&env, &DataKey::Token);
        token::Client::new(&env, &token).transfer(&env.current_contract_address(), &admin, &amount);
        env.events().publish(
            (symbol_short!("mkt"), Symbol::new(&env, "fees_withdrawn")),
            FeesWithdrawnEvent {
                admin,
                token,
                amount,
                timestamp: env.ledger().timestamp(),
            },
        );
    }

    pub fn get_market(env: Env, id: u64) -> Market {
        load_market(&env, id)
    }

    pub fn get_dispute(env: Env, id: u64) -> Option<Dispute> {
        dispute_of(&env, id)
    }

    pub fn get_fees(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::Fees).unwrap_or(0)
    }
}

#[cfg(test)]
mod test;
