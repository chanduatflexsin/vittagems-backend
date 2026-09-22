// Runs before the test framework and any test file is loaded (Jest `setupFiles`),
// so `src/config/env.ts` sees a valid environment on first import and doesn't
// call process.exit(1). dotenv.config() (invoked inside env.ts) never overwrites
// variables that are already set, so these values win.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.PORT = process.env.PORT || '3000';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/vitagems_test?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || 'test-api-key-secret-value';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value';
process.env.QUORUM_RPC_URL = process.env.QUORUM_RPC_URL || 'http://localhost:8545';
process.env.QUORUM_CHAIN_ID = process.env.QUORUM_CHAIN_ID || '7001';
process.env.VITTAGEM_CONTRACT_ADDRESS = process.env.VITTAGEM_CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000';
// Never broadcast real transactions from the unit test suite.
process.env.BLOCKCHAIN_MODE = process.env.BLOCKCHAIN_MODE || 'mock';
// The dev .env turns DAO verification on; the suite tests the direct flow by default
// and switches the flag on explicitly in the DAO tests.
process.env.DAO_VERIFICATION_ENABLED = 'false';
// Whitelist enforcement is covered by its own tests; the rest of the suite
// exercises the flows without it.
process.env.WALLET_WHITELIST_ENABLED = 'false';
// Well-known public Hardhat test account #0 key — not a real secret, safe for local/test use.
// (The all-zero key is rejected by secp256k1: it must satisfy 0 < key < curve order.)
process.env.BLOCKCHAIN_PRIVATE_KEY = process.env.BLOCKCHAIN_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-webhook-secret-value';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
