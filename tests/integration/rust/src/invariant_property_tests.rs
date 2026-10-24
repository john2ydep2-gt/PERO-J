//! Formal invariant property-based tests for contract balance vs betting pools and fees.
//!
//! Asserts the formal mathematical invariant across arbitrary action sequences:
//! ContractBalance(XLM) == sum(market.total_yes + market.total_no - market.claimed) + AccumulatedFees + sum(escrowed_bonds)

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use std::collections::HashMap;

    #[derive(Debug, Clone)]
    pub struct MarketState {
        pub total_yes: i128,
        pub total_no: i128,
        pub claimed: i128,
        pub resolved: bool,
        pub winning_outcome: Option<bool>,
        pub user_bets: Vec<(u32, bool, i128, bool)>, // (user_id, is_yes, amount, claimed)
    }

    #[derive(Debug, Clone)]
    pub struct ContractAccountingState {
        pub contract_balance: i128,
        pub accumulated_fees: i128,
        pub markets: HashMap<u32, MarketState>,
        pub escrowed_bonds: HashMap<u32, i128>,
    }

    impl ContractAccountingState {
        pub fn new() -> Self {
            Self {
                contract_balance: 0,
                accumulated_fees: 0,
                markets: HashMap::new(),
                escrowed_bonds: HashMap::new(),
            }
        }

        pub fn create_market(&mut self, market_id: u32) {
            self.markets.entry(market_id).or_insert(MarketState {
                total_yes: 0,
                total_no: 0,
                claimed: 0,
                resolved: false,
                winning_outcome: None,
                user_bets: Vec::new(),
            });
        }

        pub fn place_bet(&mut self, market_id: u32, user_id: u32, is_yes: bool, amount: i128, fee_bps: i128) {
            if let Some(market) = self.markets.get_mut(&market_id) {
                if market.resolved || amount <= 0 {
                    return;
                }
                let fee = (amount * fee_bps) / 10000;
                let net_amount = amount - fee;

                self.contract_balance += amount;
                self.accumulated_fees += fee;

                if is_yes {
                    market.total_yes += net_amount;
                } else {
                    market.total_no += net_amount;
                }
                market.user_bets.push((user_id, is_yes, net_amount, false));
            }
        }

        pub fn escrow_bond(&mut self, bond_id: u32, amount: i128) {
            if amount > 0 && !self.escrowed_bonds.contains_key(&bond_id) {
                self.contract_balance += amount;
                self.escrowed_bonds.insert(bond_id, amount);
            }
        }

        pub fn settle_bond(&mut self, bond_id: u32, refund_to_user: bool) {
            if let Some(amount) = self.escrowed_bonds.remove(&bond_id) {
                if refund_to_user {
                    self.contract_balance -= amount;
                } else {
                    self.accumulated_fees += amount;
                }
            }
        }

        pub fn resolve_market(&mut self, market_id: u32, winner: bool) {
            if let Some(market) = self.markets.get_mut(&market_id) {
                if !market.resolved {
                    market.resolved = true;
                    market.winning_outcome = Some(winner);
                }
            }
        }

        pub fn claim_payout(&mut self, market_id: u32, user_id: u32) -> i128 {
            if let Some(market) = self.markets.get_mut(&market_id) {
                if !market.resolved {
                    return 0;
                }
                let winner = market.winning_outcome.unwrap();
                let winning_pool = if winner { market.total_yes } else { market.total_no };
                let total_pool = market.total_yes + market.total_no;

                if winning_pool == 0 || total_pool == 0 {
                    return 0;
                }

                let mut user_stake = 0i128;
                for bet in &mut market.user_bets {
                    if bet.0 == user_id && bet.1 == winner && !bet.3 {
                        user_stake += bet.2;
                        bet.3 = true;
                    }
                }

                if user_stake == 0 {
                    return 0;
                }

                let payout = (user_stake * total_pool) / winning_pool;
                let max_remaining = total_pool - market.claimed;
                let actual_payout = payout.min(max_remaining);

                market.claimed += actual_payout;
                self.contract_balance -= actual_payout;
                actual_payout
            } else {
                0
            }
        }

        pub fn withdraw_fees(&mut self, amount: i128) {
            if amount > 0 && amount <= self.accumulated_fees {
                self.accumulated_fees -= amount;
                self.contract_balance -= amount;
            }
        }

        pub fn assert_formal_invariant(&self) {
            let sum_active_pools: i128 = self
                .markets
                .values()
                .map(|m| m.total_yes + m.total_no - m.claimed)
                .sum();
            let sum_escrowed_bonds: i128 = self.escrowed_bonds.values().sum();
            let expected_balance = sum_active_pools + self.accumulated_fees + sum_escrowed_bonds;

            assert_eq!(
                self.contract_balance, expected_balance,
                "Formal balance invariant violated! ContractBalance: {}, Expected: {}",
                self.contract_balance, expected_balance
            );
        }
    }

    #[derive(Debug, Clone)]
    pub enum Action {
        CreateMarket(u32),
        PlaceBet(u32, u32, bool, i128),
        EscrowBond(u32, i128),
        SettleBond(u32, bool),
        Resolve(u32, bool),
        Claim(u32, u32),
        WithdrawFees(i128),
    }

    prop_compose! {
        fn arb_action()(
            action_type in 0..7u8,
            market_id in 1..=5u32,
            user_id in 1..=10u32,
            is_yes in any::<bool>(),
            amount in 10_000..10_000_000i128,
            bond_id in 1..=10u32,
            refund in any::<bool>(),
        ) -> Action {
            match action_type {
                0 => Action::CreateMarket(market_id),
                1 => Action::PlaceBet(market_id, user_id, is_yes, amount),
                2 => Action::EscrowBond(bond_id, amount),
                3 => Action::SettleBond(bond_id, refund),
                4 => Action::Resolve(market_id, is_yes),
                5 => Action::Claim(market_id, user_id),
                _ => Action::WithdrawFees(amount / 10),
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(500))]

        #[test]
        fn test_arbitrary_bet_sequences_preserve_formal_invariant(
            actions in prop::collection::vec(arb_action(), 10..100)
        ) {
            let mut state = ContractAccountingState::new();

            // Pre-seed 3 markets
            state.create_market(1);
            state.create_market(2);
            state.create_market(3);

            for action in actions {
                match action {
                    Action::CreateMarket(m) => state.create_market(m),
                    Action::PlaceBet(m, u, is_yes, amt) => state.place_bet(m, u, is_yes, amt, 100),
                    Action::EscrowBond(b, amt) => state.escrow_bond(b, amt),
                    Action::SettleBond(b, refund) => state.settle_bond(b, refund),
                    Action::Resolve(m, winner) => state.resolve_market(m, winner),
                    Action::Claim(m, u) => { state.claim_payout(m, u); },
                    Action::WithdrawFees(amt) => state.withdraw_fees(amt),
                }

                // Assert invariant after every single action in sequence
                state.assert_formal_invariant();
            }
        }
    }
}
