import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_KEY_SECRET: z.string().min(16),
  JWT_SECRET: z.string().min(16),
  QUORUM_RPC_URL: z.string().url(),
  QUORUM_CHAIN_ID: z.string().transform(Number),
  VITTAGEM_CONTRACT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  BLOCKCHAIN_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/),

  // ── Settlement chain integration ──────────────────────────────
  // 'live'  -> BlockchainService signs and broadcasts real transactions.
  // 'mock'  -> deterministic fake tx hashes, no network (used in CI/tests).
  BLOCKCHAIN_MODE: z.enum(['live', 'mock']).default('live'),

  // Decimals used when scaling fiat amounts to on-chain uint256 units.
  // The deployed VittaGemsSettlement uses 18-decimal token units.
  SETTLEMENT_TOKEN_DECIMALS: z.string().default('18').transform(Number),

  // Corridor label applied to mints when a request does not supply one.
  DEFAULT_CORRIDOR: z.string().default('DEFAULT'),

  // ── Settlement contract generation ────────────────────────────
  // 'v1' = VittaGemsSettlement (reference-keyed ledger, currently deployed).
  // 'v2' = DAO-gated SettlementToken suite (ERC20 + DAOGovernor + registries).
  SETTLEMENT_VERSION: z.enum(['v1', 'v2']).default('v1'),

  // v2 contract addresses (required only when SETTLEMENT_VERSION=v2).
  SETTLEMENT_TOKEN_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  DAO_GOVERNOR_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  PROVIDER_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  PROOF_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // Address a redeemed settlement is transferred to before it is burned on payout
  // confirmation. Defaults to the operator wallet when unset. Must be (or will be
  // auto-registered as) an approved partner on the settlement contract.
  REDEMPTION_SINK_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),

  // Optional: on-chain permissioning contracts (for admin/diagnostics tooling).
  ACCOUNT_PERMISSIONING_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  NODE_PERMISSIONING_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional(),

  // ── DAO verification ──────────────────────────────────────────
  // When enabled, deposits are not minted and withdrawals are not burned until
  // DAO members vote to approve them. Off by default so the direct flow is unchanged.
  DAO_VERIFICATION_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Approvals needed to pass, and rejections needed to fail (as DAOGovernor.quorumThreshold).
  DAO_QUORUM: z.string().default('2').transform(Number),
  // How long the DAO has to verify an incoming deposit.
  DAO_DEPOSIT_WINDOW_MINUTES: z.string().default('60').transform(Number),
  // How long the client has to pay out fiat and get it verified before funds are released.
  DAO_WITHDRAWAL_WINDOW_MINUTES: z.string().default('60').transform(Number),
  // Extra time granted each time a bank delay is flagged, and how many times.
  DAO_WITHDRAWAL_EXTENSION_MINUTES: z.string().default('30').transform(Number),
  DAO_MAX_EXTENSIONS: z.string().default('2').transform(Number),
  // How often expired verification windows are swept.
  DAO_SWEEP_INTERVAL_SECONDS: z.string().default('10').transform(Number),

  // ── Wallet whitelist ──────────────────────────────────────────
  // Nothing is minted or transferred to an address that is not whitelisted.
  WALLET_WHITELIST_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  // ── Proof documents ───────────────────────────────────────────
  PROOF_STORAGE_DIR: z.string().default('storage/proofs'),
  PROOF_MAX_MB: z.string().default('10').transform(Number),

  WEBHOOK_SECRET: z.string().min(16),
  // Per-IP request cap per 15-minute window for /api routes.
  RATE_LIMIT_MAX: z.string().default('100').transform(Number),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
