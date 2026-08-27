# Contributing to PERO-J

Thank you for your interest in contributing to PERO-J! This document outlines how to set up your development environment, submit changes, and follow our coding standards.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive community. We have zero tolerance for harassment or discrimination.

## Getting Started

### Prerequisites

- Rust + `wasm32-unknown-unknown` target
- [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli)
- Node.js ≥ 20
- PostgreSQL ≥ 14
- Git

### Development Setup

1. **Fork and clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/PERO-J.git
   cd PERO-J
   ```

2. **Copy and configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your local test RPC URL and PostgreSQL connection string.

3. **Install dependencies**
   ```bash
   make install
   ```

4. **Build and test the contract**
   ```bash
   make build
   make test
   ```

5. **Start the development stack**
   ```bash
   make dev
   ```
   This runs the indexer and frontend in parallel. The frontend is available at `http://localhost:5173`.

## Branch Naming Convention

Use descriptive branch names with the following prefixes:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat/` | New feature | `feat/add-token-search` |
| `fix/` | Bug fix | `fix/decoder-overflow` |
| `chore/` | Maintenance, deps, docs | `chore/update-dependencies` |
| `test/` | Test additions or fixes | `test/add-decoder-coverage` |
| `refactor/` | Code refactoring | `refactor/extract-decoder-logic` |
| `docs/` | Documentation only | `docs/api-examples` |

Use lowercase letters, hyphens, and be concise (< 50 characters).

## How to add a new event decoder

Event descriptions are built in [`indexer/src/decoder.js`](indexer/src/decoder.js).
Add a case to `buildDescription` when a registered ABI function needs a
human-readable description. For example, a `claim` event whose topics contain
the claimant and amount could be added like this:

```js
case "claim": {
   const [claimant, amount] = args;
   return `Address ${fmt(claimant)} claimed ${amount} on ${contractName}`;
}
```

1. Confirm the function name and argument order in the contract ABI.
2. Add the `case "claim"` branch to `buildDescription`, keeping the fallback
    in `default` for unrecognised functions.
3. Add a test in [`indexer/test/decoder.test.js`](indexer/test/decoder.test.js).
    Build a raw event with the function symbol and XDR-encoded argument topics,
    register a matching ABI function, then assert the description contains the
    expected wording and values.
4. Run `npm test` from `indexer/`.

ABI fixtures in [`indexer/fixtures/`](indexer/fixtures/) are JSON objects with
the contract `id`, display `name`, optional `description`, and a `functions`
array. Each function entry has a `name` and its parameter metadata, for example:

```json
{
   "id": "C...",
   "name": "Example",
   "functions": [{ "name": "claim", "params": [{ "name": "claimant", "type": "address" }] }]
}
```

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type

- `feat`: A new feature
- `fix`: A bug fix
- `test`: Adding or updating tests
- `docs`: Documentation changes
- `refactor`: Code refactoring without feature or bug fix
- `perf`: Performance improvement
- `chore`: Dependency updates, build config, etc.

### Scope (optional)

The area affected by the change:
- `contract` — on-chain contract code
- `indexer` — Node.js indexer and API
- `frontend` — React frontend
- `db` — database schema or migrations

### Subject

- Use the imperative mood ("add feature" not "added feature")
- Do not capitalize the first letter
- Do not end with a period
- Maximum 50 characters

### Body (optional)

- Explain *what* and *why*, not *how*
- Wrap at 72 characters
- Reference related issues: `Closes #123`, `Relates to #456`

### Footer (optional)

- Breaking changes: `BREAKING CHANGE: description`
- Issue references: `Closes #123`

### Examples

```
feat(indexer): add SEP-41 token symbol decoding

Decode SEP-41 mint/burn/transfer events with correct symbol and decimals.
Fetch token metadata from on-chain contract storage.

Closes #89
```

```
fix(contract): prevent reentrancy in submit_event

Add state lock during event processing to prevent concurrent submissions
from corrupting the event sequence.

Relates to #92
```

## Pull Request Guidelines

### Before You Start

1. **Open an issue first** for large or breaking changes to discuss the approach
2. **Check existing PRs** to avoid duplicate work
3. **Create a feature branch** from `main`

### PR Checklist

Before submitting a PR, ensure:

- [ ] Branch follows the naming convention (`feat/`, `fix/`, etc.)
- [ ] Commits follow Conventional Commits format
- [ ] Changes are focused on a single concern (one feature or fix per PR)
- [ ] **All tests pass:** `make test` (contract), `npm test` (indexer/frontend)
- [ ] **Types check:** `npm run type-check` in `indexer/` and `frontend/`
- [ ] **Linting passes:** `npm run lint` in `indexer/` and `frontend/`
- [ ] **Code is formatted:** `cargo fmt` (contract), `npm run format` (indexer/frontend)
- [ ] **New code includes tests** (aim for > 80% coverage for critical logic)
- [ ] **Documentation is updated** (README.md, API docs, inline comments for complex logic)
- [ ] **No secrets in code** (no API keys, private keys, or credentials)
- [ ] **Commit messages are clear and descriptive**

### PR Description Template

```markdown
## Description
Brief summary of the change and why it is needed.

## Type of Change
- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change

## Motivation
Why is this change necessary? What problem does it solve?

## Testing
How was this tested? Include steps to reproduce or test cases.

## Screenshots (if applicable)
Include screenshots for UI changes.

## Checklist
- [ ] Tests pass locally
- [ ] No linting errors
- [ ] Documentation updated
- [ ] No secrets or credentials added
```

## Code Style

### Rust (Contract)

- Follow [Rust conventions](https://rust-lang.github.io/api-guidelines/)
- Use `cargo fmt` for automatic formatting
- Use `cargo clippy` for linting
- Aim for > 80% test coverage for critical logic

### JavaScript/TypeScript (Indexer & Frontend)

- Use **Prettier** for formatting (configured in `.prettierrc`)
- Use **ESLint** for linting (configured in `.eslintrc`)
- Use **TypeScript** for type safety
- Prefer `const` over `let` or `var`
- Use async/await over `.then()` chains
- Add JSDoc comments for public functions and exports

Run code style checks:
```bash
# Indexer
cd indexer
npm run lint
npm run format

# Frontend
cd frontend
npm run lint
npm run format
```

## Testing

### Contract Tests

Write tests for all contract functions using the Soroban test framework:

```bash
make test
```

### Indexer & Frontend Tests

Write unit and integration tests:

```bash
# Indexer
cd indexer
npm test

# Frontend
cd frontend
npm test
```

Aim for > 80% coverage of critical paths (decoder logic, API endpoints, UI components).

## Documentation

- Update **README.md** if you add or change user-facing features
- Add **inline comments** for complex logic, especially in the decoder
- Include **JSDoc** for public functions
- Document **breaking changes** in the PR description

## Filing a Good Bug Report

### Use the Bug Report Template

1. Go to [Issues](https://github.com/PERO-J/PERO-J/issues)
2. Click "New Issue" → "Bug Report"
3. Fill out all sections:

### Bug Report Template

```markdown
## Description
A clear description of what the bug is.

## Steps to Reproduce
1. Set up environment with [specific configuration]
2. Run [command or action]
3. Observe [actual behavior]

## Expected Behavior
What should have happened instead.

## Environment
- OS: [e.g., macOS, Linux]
- Node.js version: [output of `node --version`]
- Rust version: [output of `rustc --version`]
- PostgreSQL version: [output of `psql --version`]
- Stellar CLI version: [output of `stellar version`]

## Logs
Include relevant error messages or logs (wrap in code blocks):
```bash
[paste error or log output]
```
```

## Additional Context
Add any other context, screenshots, or relevant links.
```

### Tips for Good Bug Reports

- **Be specific:** "Decoder fails on SEP-41 mint events" is better than "Something broke"
- **Provide reproducibility steps:** We must be able to reproduce the bug to fix it
- **Include environment details:** Version mismatches are a common cause
- **Attach logs:** Always include the full error message and stack trace
- **One bug per issue:** Don't combine multiple bugs in one report

## Review Process

1. A maintainer will review your PR within 5 business days
2. Changes may be requested; push new commits to your branch
3. Once approved, a maintainer will merge and delete your feature branch
4. Your contribution will be credited in the release notes

## Release Process

Releases follow [Semantic Versioning](https://semver.org/):

- **Major (X.0.0):** Breaking API or smart contract changes
- **Minor (0.X.0):** New features (backward compatible)
- **Patch (0.0.X):** Bug fixes (backward compatible)

Contributors are credited in `CHANGELOG.md` and release notes.

## Questions?

- **Setup issues:** Open a GitHub discussion or issue
- **Security vulnerabilities:** See [SECURITY.md](SECURITY.md)
- **General questions:** Ask in discussions or the Stellar Discord `#soroban-dev` channel

---

Thank you for contributing to PERO-J! 🙌
