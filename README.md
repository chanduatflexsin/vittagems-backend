# VittaGems Settlement API Service

A highly secure, robust, and scalable backend API service built in Node.js + TypeScript to act as the bridge between third-party payment platforms, the VittaGems API, and the Quorum Blockchain. 

## Features

- **API Key & Scope Auth**: API keys are securely hashed via HMAC. Each key supports fine-grained scopes (e.g., `MINT`, `TRANSFER`).
- **Idempotency**: Prevents double-spending and duplicate blockchain operations via strict `Idempotency-Key` headers.
- **Asynchronous Blockchain Engine**: Uses BullMQ + Redis to queue transactions (Mint, Transfer, Burn) ensuring fast HTTP responses and reliable blockchain interactions.
- **Webhook Delivery**: Notifies third-party integrators asynchronously with built-in retries and HMAC signatures.
- **Modular Clean Architecture**: Separated domain models (Clients, Deposits, Mint, Transfers, Withdrawals, Admin).
- **PostgreSQL + Prisma**: Strongly typed database ORM with automated migrations.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/en/) (v18+)
- [Docker](https://www.docker.com/) & Docker Compose

### Environment Setup

Copy the sample environment file:
```bash
cp .env.example .env
```
Ensure that `API_KEY_SECRET` and `JWT_SECRET` are set to secure random strings.

### Run via Docker (Database & Redis)

Start the required infrastructure (PostgreSQL & Redis):
```bash
docker-compose up -d
```

### Install Dependencies & Initialize Database

```bash
npm install
npm run db:push     # Synchronizes Prisma schema with PostgreSQL
npm run db:generate # Generates TypeScript definitions for Prisma
```

### Start the Application

```bash
# Run in development mode (auto-reload)
npm run dev

# Or build and start for production
npm run build
npm start
```

## API Documentation

Once the server is running (default is `http://localhost:3000`), you can view the complete interactive OpenAPI/Swagger documentation at:

**[http://localhost:3000/api-docs](http://localhost:3000/api-docs)**

### Standard Flow Example

1. **Register Client:** `POST /api/v1/clients/register`
   - Returns your raw API Key. *Save this, it is only shown once.*
2. **Mock Deposit:** `POST /api/v1/deposits`
   - Use the API key as a Bearer token. This mocks a bank verifying fiat.
3. **Mint Tokens:** `POST /api/v1/mint`
   - Provide the `Idempotency-Key` header and the Deposit reference.
   - Triggers the blockchain worker to issue tokens.
4. **Check Status:** `GET /api/v1/mint/:id`
   - Check if the Mint transaction is `CONFIRMED`.

## Blockchain Settlement Integration

The backend settles fiat on the **VittaGems GoQuorum** network (chainId **7001**, zero-gas)
against the deployed `VittaGemsSettlement` contract — a **reference-keyed settlement ledger**
(not an ERC-20). `src/blockchain/BlockchainService.ts` maps each backend operation to the
real contract call:

| Backend op | Contract call | Role required |
|-----------|---------------|---------------|
| Mint | `mintWithTreasuryApproval(amount, partner, referenceId, corridor)` | TREASURY_ADMIN |
| Transfer | `transfer(referenceId, to, amount)` | SETTLEMENT_AGENT |
| Reconcile | `reconcile(referenceId)` | SETTLEMENT_AGENT |
| Burn | `burn(referenceId)` | SETTLEMENT_AGENT |

Key points:

- **Every settlement op is keyed by a `referenceId`.** Mint uses the verified deposit's
  `referenceId`; `POST /transfers` and `POST /withdrawals` now **require** a `referenceId`
  (the settlement to act on). Mint also accepts an optional `corridor`.
- **Amounts** (fiat `Decimal`) are scaled to the contract's 18-decimal units
  (`SETTLEMENT_TOKEN_DECIMALS`).
- The **operator wallet** (`BLOCKCHAIN_PRIVATE_KEY`) is the deployer/treasury; the worker
  self-grants `SETTLEMENT_AGENT` + `COMPLIANCE_OPERATOR` on first use, and registers a partner
  on-chain only if that wallet is whitelisted (see below). The wallet must also be listed in the network's
  `permission-config.json` (see below) or its transactions are rejected at the node.
- **Withdrawal / burn:** flow is _request → pay fiat off-chain → confirm sent → burn_.
  The contract can't burn a `MINTED` settlement directly, so confirming a payout
  (`POST /withdrawals/:id/approve`) runs `closeSettlementForWithdrawal`, which walks it
  `MINTED → transfer (to REDEMPTION_SINK_ADDRESS) → reconcile → burn → CLOSED` and then marks
  the withdrawal `SETTLED`. Only call approve **after** the fiat has actually been sent.
- Set `BLOCKCHAIN_MODE=mock` to run without a node (used by the test suite); `live` broadcasts
  real transactions.
- **Network permissioning:** the Quorum nodes run with `--permissioned` and GoQuorum
  Permissioning v2 (`permission-config.json`), so only accounts listed there may submit
  transactions — anyone else is rejected with `account does not have permission for the
  transaction`. The operator wallet must be in that list. Note this is *chain-level* access
  control; partner wallets only ever receive settlements (ledger entries) and never sign, so
  they do not need to be permissioned.
- **Startup preflight:** the server verifies the RPC is reachable, the chain id matches, and
  the settlement contract exists at `VITTAGEM_CONTRACT_ADDRESS` before it accepts traffic. If
  the Quorum network is rebuilt, redeploy the contract and update that address — otherwise
  startup fails loudly with `SETTLEMENT_CONTRACT_MISSING` instead of failing on every mint.

Verify the full lifecycle against a running network:

```bash
npm run verify:onchain
```

## Architecture & Scalability

- **API Layer**: Handles validation (Zod), Authentication, Idempotency checks.
- **Domain Services**: Orchestrates business logic and queues BullMQ jobs.
- **Workers**: 
  - `transaction.worker.ts`: Executes blockchain operations safely.
  - `webhook.worker.ts`: Retries external HTTP notifications securely.

## Security Controls

- `helmet` and `cors` are enabled.
- `express-rate-limit` is configured to prevent brute force.
- Database access only stores hashes of sensitive tokens.

## Running Tests

We use Jest for automated integration testing:

```bash
npm run test
```

## DAO verification of deposits and withdrawals

Set `DAO_VERIFICATION_ENABLED=true` and no value moves on-chain until independent DAO
members have verified the off-chain fiat leg. Members authenticate with their own tokens
(`X-DAO-Token`), never a client API key, so the party moving money is never the party
approving it.

**Deposit → mint**

1. `POST /deposits` with `proof.bankReference` (UTR) - deposit is `PENDING_VERIFICATION`
2. `POST /mint` - recorded as `AWAITING_APPROVAL`, **not** sent to the chain
3. Members review the evidence and vote: `POST /dao/proposals/{id}/votes`
4. `DAO_QUORUM` approvals -> deposit `VERIFIED`, mint released to the chain.
   `DAO_QUORUM` rejections (a comment is required) or the window closing -> deposit
   `REJECTED`, nothing is minted.

**Withdrawal → burn or release**

1. `POST /withdrawals` - the settlement is **locked on-chain** (`hold` -> `ON_HOLD`), so it cannot be moved
2. The client pays the customer from its bank, then `POST /withdrawals/{id}/payout-proof` with that UTR
   (members cannot vote before this exists)
3. Bank slow? `POST /withdrawals/{id}/extend` adds `DAO_WITHDRAWAL_EXTENSION_MINUTES`, up to `DAO_MAX_EXTENSIONS` times
4. Approved -> lock lifted and the settlement burned -> `SETTLED`.
   Rejected, or nobody verified it before the window closed -> lock lifted and funds returned -> `RELEASED`
   with *"Withdrawal not yet finished ... your locked funds have been released back to you"*.

A background sweeper (`DAO_SWEEP_INTERVAL_SECONDS`) closes expired windows. Every proposal keeps an
append-only timeline (created, votes, extensions, lock, release, burn). The thresholds match the v2
`DAOGovernor` contract, so moving the votes on-chain later does not change the rules.

| Setting | Meaning |
|---|---|
| `DAO_QUORUM` | Approvals to pass, and rejections to fail |
| `DAO_DEPOSIT_WINDOW_MINUTES` | Time the DAO has to verify a deposit |
| `DAO_WITHDRAWAL_WINDOW_MINUTES` | Time to pay out and be verified before funds are released (a request may pass `windowMinutes`, 1-1440) |
| `DAO_WITHDRAWAL_EXTENSION_MINUTES` / `DAO_MAX_EXTENSIONS` | Bank-delay extensions |

```bash
npm run e2e:dao   # approve, reject, lock->burn, lock->release, extension, window expiry - against the live chain
```

The XPZ demo portal has a **DAO Verification** console (switch between demo members, review
evidence, vote, extend) alongside XPZ's own payments and withdrawals.

**Limits of this version:** votes are recorded and enforced by the backend (auditable, not yet
trustless) - the operator key could still act outside the DAO. On the v1 contract a withdrawal
can only redeem a whole settlement, and a settlement already paid out to a partner is held by that
partner and cannot be withdrawn by the client. `POST /dao/members` is public for the demo and must
be admin-only in production.

## Wallet whitelist and proof documents

**Nothing settles to an address that is not whitelisted.** `WALLET_WHITELIST_ENABLED=true`
(the default) means a mint, transfer or withdrawal is refused with `WALLET_NOT_WHITELISTED`
unless the address is ACTIVE in the whitelist.

- Registering a client submits its `blockchainAddress` automatically, as `PENDING`; a client
  can register more with `POST /wallets`.
- DAO members review the queue (`GET /dao/wallets`) and approve, reject or revoke
  (`POST /dao/wallets/{id}/approve|reject|revoke`). Rejecting and revoking require a reason,
  which is shown back to the client in the error.
- Enforced twice: when the request is made, and again in the worker immediately before
  signing - so a wallet revoked while a job sits in the queue is still stopped.
- The on-chain `registerPartner` call only ever happens for an approved wallet, so the
  contract's approved partners stay a subset of the whitelist. (Previously the worker
  auto-registered any address it was handed, which is exactly what this replaces.)

**Proof documents.** Deposits and payouts can carry supporting evidence - a bank statement,
a receipt screenshot, a PDF - which DAO members read next to the bank reference:

```bash
# the file goes up as the raw request body; no multipart, no base64
curl -X POST localhost:3000/api/v1/deposits/$DEPOSIT_ID/documents \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/pdf" -H "X-File-Name: statement.pdf" \
  --data-binary @statement.pdf
```

Images, PDF, text/CSV, Word and Excel are accepted, up to `PROOF_MAX_MB` (10 by default);
anything else is refused. Files are written under `PROOF_STORAGE_DIR` under a generated key
(never the uploaded name, so a name can't escape the directory), and each is stored with its
SHA-256 so a document can be shown to have not changed. `POST /withdrawals/{id}/documents`
does the same for payout receipts. Members open them at `GET /dao/documents/{id}`; a client
can read back only its own via `GET /documents/{id}`.

```bash
npm run e2e:wallets   # whitelist enforcement + upload/download, against the live chain
```

## Demo integrator portal (XPZ Corp)

`demo/xpz-portal/` is a dependency-free frontend that plays the role of a **third-party
company ("XPZ Corp") running its own business** (customers, invoices, partner payouts,
cash-outs) and delegating **only the settlement step** to this API. Use it to test the
integration end-to-end the way a real partner would.

```bash
npm run dev        # Settlement API + worker on :3000 (needs Postgres, Redis, Quorum)
npm run demo:xpz   # XPZ portal on http://localhost:4173
```

In the portal: **Connection → Onboard** (registers a client, stores the API key in the
browser) → **Customer Payments → Seed samples → Settle on-chain** (deposit + mint) →
**Partner Payouts** (transfer) → **Withdrawals → Request → "Fiat sent → close"**
(approve → transfer/reconcile/burn → SETTLED). The **API Console** tab logs every
request/response. XPZ's own data lives in `localStorage`; **Reset demo data** clears it.

> Run only **one** API server at a time — importing the queue starts the worker
> in-process, so two servers mean two workers competing for the same Redis queue.
