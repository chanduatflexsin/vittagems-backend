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
  self-grants `SETTLEMENT_AGENT` + `COMPLIANCE_OPERATOR` on first use and auto-registers a
  partner before minting to it. The wallet must be registered in the on-chain account
  permissioning contract or its transactions are dropped at the node.
- **Withdrawal / burn:** flow is _request → pay fiat off-chain → confirm sent → burn_.
  The contract can't burn a `MINTED` settlement directly, so confirming a payout
  (`POST /withdrawals/:id/approve`) runs `closeSettlementForWithdrawal`, which walks it
  `MINTED → transfer (to REDEMPTION_SINK_ADDRESS) → reconcile → burn → CLOSED` and then marks
  the withdrawal `SETTLED`. Only call approve **after** the fiat has actually been sent.
- Set `BLOCKCHAIN_MODE=mock` to run without a node (used by the test suite); `live` broadcasts
  real transactions.

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
