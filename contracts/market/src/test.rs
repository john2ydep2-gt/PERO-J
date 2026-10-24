extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Env, TryFromVal,
};

const XLM: i128 = 10_000_000;

struct Ctx<'a> {
    env: Env,
    admin: Address,
    client: MarketContractClient<'a>,
    token: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
}

fn setup<'a>() -> Ctx<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);
    let admin = Address::generate(&env);
    let sac_id = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let id = env.register_contract(None, MarketContract);
    let client = MarketContractClient::new(&env, &id);
    client.init(&admin, &sac_id);
    client.create_market(&admin, &1);
    Ctx {
        token: TokenClient::new(&env, &sac_id),
        sac: StellarAssetClient::new(&env, &sac_id),
        env,
        admin,
        client,
    }
}

fn expect(e: Error) -> Option<Result<soroban_sdk::Error, soroban_sdk::InvokeError>> {
    Some(Ok(soroban_sdk::Error::from_contract_error(e as u32)))
}

fn funded(c: &Ctx, amount: i128) -> Address {
    let a = Address::generate(&c.env);
    c.sac.mint(&a, &amount);
    a
}

fn emitted(c: &Ctx, name: &str) -> usize {
    let sym = Symbol::new(&c.env, name);
    c.env
        .events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            topics.len() == 2
                && Symbol::try_from_val(&c.env, &topics.get(1).unwrap()).ok() == Some(sym.clone())
        })
        .count()
}

#[test]
fn bond_scales_with_pool_volume() {
    let c = setup();
    assert_eq!(c.client.required_bond(&1, &false), BASE_BOND);
    assert_eq!(c.client.required_bond(&1, &true), BASE_CHALLENGE_BOND);

    // 5,000 XLM pool -> 1% = 50 XLM, still below the base bond.
    let u = funded(&c, 2_000_000 * XLM);
    c.client.place_bet(&u, &1, &1, &(5_000 * XLM));
    assert_eq!(c.client.required_bond(&1, &false), BASE_BOND);

    // 100,000 XLM pool -> 1,000 XLM.
    c.client.place_bet(&u, &1, &0, &(95_000 * XLM));
    assert_eq!(c.client.required_bond(&1, &false), 1_000 * XLM);
    assert_eq!(c.client.required_bond(&1, &true), 1_000 * XLM);

    // 1,000,000 XLM pool -> 10,000 XLM.
    c.client.place_bet(&u, &1, &0, &(900_000 * XLM));
    assert_eq!(c.client.required_bond(&1, &false), 10_000 * XLM);
}

#[test]
fn insufficient_bond_reverts() {
    let c = setup();
    let u = funded(&c, 1_000_000 * XLM);
    c.client.place_bet(&u, &1, &1, &(100_000 * XLM));
    let required = c.client.required_bond(&1, &false);

    let r = c.client.try_submit_outcome(&u, &1, &1, &(required - 1));
    assert_eq!(r.err(), expect(Error::InsufficientBond));
    c.client.submit_outcome(&u, &1, &1, &required);
    assert_eq!(c.token.balance(&c.client.address), 100_000 * XLM + required);

    let d = funded(&c, 1_000_000 * XLM);
    let r = c.client.try_challenge_outcome(&d, &1, &(required - 1));
    assert_eq!(r.err(), expect(Error::InsufficientBond));
    c.client.challenge_outcome(&d, &1, &required);
}

#[test]
fn one_sided_market_cancels_and_refunds() {
    let c = setup();
    let a = funded(&c, 100 * XLM);
    let b = funded(&c, 50 * XLM);
    c.client.place_bet(&a, &1, &1, &(100 * XLM));
    c.client.place_bet(&b, &1, &1, &(50 * XLM));

    // Everyone bet YES but the market resolves NO: no payouts would be possible.
    assert_eq!(c.client.resolve_market(&c.admin, &1, &0), Status::Cancelled);
    assert_eq!(c.client.get_fees(), 0);

    assert_eq!(c.client.claim(&a, &1), 100 * XLM);
    assert_eq!(c.client.claim(&b, &1), 50 * XLM);
    assert_eq!(c.token.balance(&a), 100 * XLM);
    assert_eq!(c.token.balance(&c.client.address), 0);
    assert_eq!(
        c.client.try_claim(&a, &1).err(),
        expect(Error::AlreadyClaimed)
    );
}

#[test]
fn claim_emits_event_and_zero_claim_does_not() {
    let c = setup();
    let w = funded(&c, 100 * XLM);
    let l = funded(&c, 100 * XLM);
    c.client.place_bet(&w, &1, &1, &(100 * XLM));
    c.client.place_bet(&l, &1, &0, &(100 * XLM));
    assert_eq!(c.client.resolve_market(&c.admin, &1, &1), Status::Resolved);

    // 200 XLM pool minus 2% fee goes to the sole winner.
    assert_eq!(c.client.claim(&w, &1), 196 * XLM);
    assert_eq!(emitted(&c, "claimed"), 1);

    assert_eq!(
        c.client.try_claim(&l, &1).err(),
        expect(Error::NothingToClaim)
    );
}

#[test]
fn withdraw_fees_emits_event_only_when_authorized() {
    let c = setup();
    let w = funded(&c, 100 * XLM);
    let l = funded(&c, 100 * XLM);
    c.client.place_bet(&w, &1, &1, &(100 * XLM));
    c.client.place_bet(&l, &1, &0, &(100 * XLM));
    c.client.resolve_market(&c.admin, &1, &1);
    assert_eq!(c.client.get_fees(), 4 * XLM);

    let other = Address::generate(&c.env);
    let r = c.client.try_withdraw_fees(&other, &(4 * XLM));
    assert_eq!(r.err(), expect(Error::Unauthorized));
    assert_eq!(emitted(&c, "fees_withdrawn"), 0);

    c.client.withdraw_fees(&c.admin, &(4 * XLM));
    assert_eq!(emitted(&c, "fees_withdrawn"), 1);
    assert_eq!(c.token.balance(&c.admin), 4 * XLM);
    assert_eq!(c.client.get_fees(), 0);
}

fn disputed<'a>(c: &Ctx<'a>) -> (Vec<Address>, Address, Address) {
    let council = Vec::from_array(
        &c.env,
        [
            Address::generate(&c.env),
            Address::generate(&c.env),
            Address::generate(&c.env),
        ],
    );
    c.client.set_council(&c.admin, &council, &2);
    let bettor = funded(c, 100 * XLM);
    let other = funded(c, 100 * XLM);
    c.client.place_bet(&bettor, &1, &1, &(100 * XLM));
    c.client.place_bet(&other, &1, &0, &(100 * XLM));
    let submitter = funded(c, BASE_BOND);
    let disputer = funded(c, BASE_CHALLENGE_BOND);
    c.client.submit_outcome(&submitter, &1, &1, &BASE_BOND);
    c.client
        .challenge_outcome(&disputer, &1, &BASE_CHALLENGE_BOND);
    (council, submitter, disputer)
}

#[test]
fn finalize_dispute_respects_timelock() {
    let c = setup();
    let (council, submitter, disputer) = disputed(&c);
    c.client.vote_dispute(&council.get(0).unwrap(), &1, &0);
    assert_eq!(
        c.client.try_finalize_dispute(&1).err(),
        expect(Error::ThresholdNotReached)
    );
    c.client.vote_dispute(&council.get(1).unwrap(), &1, &0);

    let t0 = c.env.ledger().timestamp();
    assert_eq!(c.client.get_dispute(&1).unwrap().threshold_reached_at, t0);
    assert_eq!(
        c.client.try_finalize_dispute(&1).err(),
        expect(Error::TimelockActive)
    );

    c.env.ledger().set_timestamp(t0 + TIMELOCK_SECS - 1);
    assert_eq!(
        c.client.try_finalize_dispute(&1).err(),
        expect(Error::TimelockActive)
    );

    c.env.ledger().set_timestamp(t0 + TIMELOCK_SECS);
    assert_eq!(c.client.finalize_dispute(&1), Status::Resolved);
    assert_eq!(c.client.get_market(&1).winning_side, 0);
    // Council overturned the proposal: disputer's bond back, submitter's forfeited.
    assert_eq!(c.token.balance(&disputer), BASE_CHALLENGE_BOND);
    assert_eq!(c.token.balance(&submitter), 0);
    assert_eq!(c.client.get_fees(), 4 * XLM + BASE_BOND);
}

#[test]
fn admin_can_veto_during_timelock() {
    let c = setup();
    let (council, _, _) = disputed(&c);
    c.client.vote_dispute(&council.get(0).unwrap(), &1, &0);
    c.client.vote_dispute(&council.get(1).unwrap(), &1, &0);

    c.client.veto_dispute(&c.admin, &1);
    assert_eq!(
        c.client.try_finalize_dispute(&1).err(),
        expect(Error::ThresholdNotReached)
    );

    // Votes were reset, so the council can vote again.
    c.client.vote_dispute(&council.get(0).unwrap(), &1, &1);
    c.client.vote_dispute(&council.get(1).unwrap(), &1, &1);
    let t0 = c.env.ledger().timestamp();
    c.env.ledger().set_timestamp(t0 + TIMELOCK_SECS);
    assert_eq!(
        c.client.try_veto_dispute(&c.admin, &1).err(),
        expect(Error::InvalidState)
    );
    assert_eq!(c.client.finalize_dispute(&1), Status::Resolved);
    assert_eq!(c.client.get_market(&1).winning_side, 1);
}
