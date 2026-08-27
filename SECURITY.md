# Security Policy

## Supported Versions

| Version | Status | Security Updates |
|---------|--------|------------------|
| 1.x (Testnet) | Active | Yes |
| < 1.0 | Pre-release | No |

Mainnet releases will receive security updates for a minimum of 12 months from release.

## Reporting a Vulnerability

If you discover a security vulnerability in PERO-J, please report it privately to prevent public disclosure before a fix is available.

**Do not open a public GitHub issue for security vulnerabilities.**

### Reporting Methods

1. **GitHub Security Advisory (Preferred)**
   - Navigate to the [Security tab](https://github.com/PERO-J/PERO-J/security/advisories)
   - Click "Report a vulnerability"
   - Fill out the form with details of the vulnerability
   - This creates a private discussion visible only to maintainers

2. **Email**
   - Send a detailed report to: `security@pero-j.dev`
   - Include steps to reproduce, impact assessment, and proposed remediation
   - PGP key available upon request for highly sensitive disclosures

### What to Include

- **Description:** Clear explanation of the vulnerability
- **Type:** (e.g., smart contract logic flaw, input validation, XSS, injection, etc.)
- **Affected Component:** (e.g., on-chain contract, indexer, frontend)
- **Steps to Reproduce:** Detailed instructions or proof-of-concept
- **Impact:** Severity and potential consequences
- **Suggested Fix:** (optional, but appreciated)

## Response Timeline

- **Initial Acknowledgment:** Within 24 hours
- **Triage & Assessment:** Within 72 hours
- **Fix Development & Testing:** Varies by severity (see below)
- **Public Disclosure:** Coordinated with the reporter, typically 30–90 days after a fix is released

### Severity Levels

| Severity | Examples | Timeline |
|----------|----------|----------|
| **Critical** | Fund loss, contract lock-up, consensus failure | 7 days |
| **High** | Unauthorized state changes, access control bypass | 14 days |
| **Medium** | Information leakage, denial-of-service | 30 days |
| **Low** | Minor bugs, edge cases with limited impact | 60 days |

## Responsible Disclosure

We follow coordinated vulnerability disclosure practices:

1. Researchers report vulnerabilities privately
2. PERO-J maintainers acknowledge receipt and begin investigation
3. A patch is developed and tested
4. The fix is released, and the vulnerability is publicly disclosed after release
5. Credit is given to the reporter (unless anonymity is requested)

We do not offer monetary bug bounties at this time, but we recognize responsible disclosures in release notes and on this page.

## Security Best Practices

### Admin Transfer Procedure

`transfer_admin` intentionally requires authorization from both the current
admin and the new admin before ownership changes. This prevents a mistyped
address from permanently locking the contract, but it means the new admin must
co-sign the same transaction. The new admin does not need to be online at the
time the transaction is created; the transaction can be prepared and shared
for signing.

For a handoff using a hardware wallet or multi-signature account:

1. Build an invoke transaction calling `transfer_admin` with the current admin
   and new admin addresses.
2. Simulate and prepare the transaction with the network's Soroban tooling.
3. Have the current admin sign its authorization entry.
4. Share the prepared transaction or auth envelope with the new admin. Have
   the new admin sign its authorization entry; for a multi-signature account,
   collect the signatures required by that account's signer policy.
5. Combine the signatures, verify both authorization entries and the target
   address, then submit the transaction to the network.

Do not submit until both parties have verified the new address. A failed or
expired prepared transaction must be rebuilt and signed again.

### For Users

- **Do not share your Stellar private keys** with any service, including PERO-J
- Use testnet for exploratory transactions before mainnet deployment
- Verify contract addresses before calling smart contracts
- Monitor your wallet transactions regularly

### For Developers

- Review the contract code in `contract/` before integrating PERO-J ABIs
- Test ABI decoders with known-good values before trusting decoded events
- Keep dependencies up-to-date (`npm audit`, `cargo audit`)
- Do not hardcode secrets in environment files; use a secure secrets manager

## Security Audits

PERO-J has not undergone a third-party security audit. The project is currently in **testnet development**. A formal audit is planned before mainnet deployment as outlined in [ROADMAP.md](ROADMAP.md).

## Contact

For non-security questions or general inquiries, please open a GitHub issue or discussion. For security matters, use the reporting methods above.

---

**Last Updated:** 2026-07-27  
**Policy Version:** 1.0
