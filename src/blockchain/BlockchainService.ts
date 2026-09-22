import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

/**
 * On-chain settlement status enum, mirrored from VittaGemsSettlement.sol.
 * Index order MUST match the Solidity enum.
 */
export const SETTLEMENT_STATUS = [
  'CREATED',
  'COMPLIANCE_APPROVED',
  'MINTED',
  'TRANSFERRED',
  'PAYOUT_CONFIRMED',
  'CLOSED',
  'ON_HOLD',
  'FROZEN',
] as const;
export type SettlementStatusName = (typeof SETTLEMENT_STATUS)[number];

export interface OnChainSettlement {
  referenceId: string;
  partner: string;
  amount: bigint;
  status: SettlementStatusName;
  createdAt: bigint;
  updatedAt: bigint;
  corridor: string;
  exists: boolean;
}

export interface IBlockchainService {
  mint(referenceId: string, partnerAddress: string, amount: string, corridor: string): Promise<string>;
  transfer(referenceId: string, toAddress: string, amount: string): Promise<string>;
  reconcile(referenceId: string): Promise<string>;
  burn(referenceId: string): Promise<string>;
  closeSettlementForWithdrawal(referenceId: string, opts?: { releaseWithdrawalHold?: boolean }): Promise<string>;
  hold(referenceId: string, reason: string): Promise<string>;
  releaseHold(referenceId: string): Promise<string | null>;
  registerPartner(partnerAddress: string, name: string): Promise<string>;
  isPartnerApproved(partnerAddress: string): Promise<boolean>;
  getSettlement(referenceId: string): Promise<OnChainSettlement>;
  getOutstandingBalance(address: string): Promise<bigint>;
  ensureOperatorRoles(): Promise<void>;
  preflight(): Promise<void>;
  getTransactionStatus(txHash: string): Promise<'PENDING' | 'CONFIRMED' | 'FAILED'>;
}

/**
 * Bridges the settlement backend to the deployed VittaGemsSettlement contract
 * on the VittaGems Quorum network.
 *
 * The deployed contract is a reference-keyed settlement ledger (NOT an ERC20):
 *   - mintWithTreasuryApproval(amount, partner, referenceId, corridor)  [TREASURY_ADMIN]
 *   - transfer(referenceId, to, amount)                                 [SETTLEMENT_AGENT]
 *   - reconcile(referenceId)                                            [SETTLEMENT_AGENT]
 *   - burn(referenceId)                                                 [SETTLEMENT_AGENT]
 *
 * Amounts are scaled from fiat units to the contract's 18-decimal units.
 */
export class BlockchainService implements IBlockchainService {
  private provider!: ethers.JsonRpcProvider;
  private wallet!: ethers.Wallet;
  private contract!: ethers.Contract;
  private readonly mock: boolean;
  private readonly decimals: number;
  private rolesEnsured = false;

  // ABI subset of the deployed VittaGemsSettlement (+ inherited VittaGemsRBAC).
  private static readonly ABI = [
    // Settlement lifecycle
    'function mintWithTreasuryApproval(uint256 _amount, address _partnerAddress, string _referenceId, string _corridor) external',
    'function transfer(string _referenceId, address _to, uint256 _amount) external',
    'function reconcile(string _referenceId) external',
    'function burn(string _referenceId) external',
    'function hold(string _referenceId, string _reason) external',
    'function release(string _referenceId) external',
    'function freeze(address _account, string _reason) external',
    'function unfreeze(address _account) external',
    // Partner management
    'function registerPartner(address _partner, string _name) external',
    'function removePartner(address _partner) external',
    'function approvedPartners(address) view returns (bool)',
    'function frozenAccounts(address) view returns (bool)',
    // Views
    'function getSettlement(string _referenceId) view returns (tuple(string referenceId, address partner, uint256 amount, uint8 status, uint256 createdAt, uint256 updatedAt, string corridor))',
    'function getOutstandingBalance(address _partner) view returns (uint256)',
    'function totalMinted() view returns (uint256)',
    'function totalBurned() view returns (uint256)',
    'function reserveLimit() view returns (uint256)',
    'function perTransactionLimit() view returns (uint256)',
    'function dailyLimit() view returns (uint256)',
    // RBAC (from VittaGemsRBAC / AccessControl)
    'function TREASURY_ADMIN() view returns (bytes32)',
    'function SETTLEMENT_AGENT() view returns (bytes32)',
    'function COMPLIANCE_OPERATOR() view returns (bytes32)',
    'function assignRole(bytes32 _role, address _account) external',
    'function hasRole(bytes32 role, address account) view returns (bool)',
    // Events
    'event MintCompleted(string indexed referenceId, address indexed partner, uint256 amount, uint256 timestamp)',
    'event TransferSettled(string indexed referenceId, address indexed from, address indexed to, uint256 amount, uint256 timestamp)',
    'event BurnCompleted(string indexed referenceId, address indexed partner, uint256 amount, uint256 timestamp)',
  ];

  constructor() {
    this.mock = env.BLOCKCHAIN_MODE === 'mock';
    this.decimals = env.SETTLEMENT_TOKEN_DECIMALS;

    if (this.mock) {
      // Still derive a wallet so `signerAddress` is available, but never touch the network.
      const provider = new ethers.JsonRpcProvider(env.QUORUM_RPC_URL);
      this.provider = provider;
      this.wallet = new ethers.Wallet(env.BLOCKCHAIN_PRIVATE_KEY, provider);
      logger.warn('BlockchainService running in MOCK mode — no real transactions will be broadcast');
      return;
    }

    // Pin a static network so ethers does not re-probe chainId on every call
    // (GoQuorum's chainId/networkId reporting can otherwise trip auto-detection).
    const network = new ethers.Network('quorum', BigInt(env.QUORUM_CHAIN_ID));
    this.provider = new ethers.JsonRpcProvider(env.QUORUM_RPC_URL, network, {
      staticNetwork: network,
    });
    this.wallet = new ethers.Wallet(env.BLOCKCHAIN_PRIVATE_KEY, this.provider);
    this.contract = new ethers.Contract(env.VITTAGEM_CONTRACT_ADDRESS, BlockchainService.ABI, this.wallet);
  }

  get signerAddress(): string {
    return this.wallet.address;
  }

  /** Scale a fiat/decimal amount string to the contract's uint256 units. */
  private toUnits(amount: string): bigint {
    return ethers.parseUnits(amount, this.decimals);
  }

  /** GoQuorum is a zero-gas network; all txs must be sent with gasPrice 0. */
  private txOverrides(): ethers.Overrides {
    return { gasPrice: 0, type: 0 };
  }

  /**
   * Verify the configured chain and contract are actually usable before serving traffic.
   * Catches the common failure mode where the Quorum network is rebuilt and the
   * previously deployed settlement contract no longer exists at the configured address.
   */
  async preflight(): Promise<void> {
    if (this.mock) {
      logger.warn('Blockchain preflight skipped - BLOCKCHAIN_MODE=mock');
      return;
    }

    // 1. Chain reachable, and reporting the chain id we are configured for.
    let onChainId: number;
    try {
      onChainId = Number((await this.provider.getNetwork()).chainId);
    } catch (error: any) {
      throw new AppError(
        `Cannot reach the Quorum RPC at ${env.QUORUM_RPC_URL}: ${error.shortMessage || error.message}`,
        503,
        'CHAIN_UNREACHABLE',
      );
    }
    if (onChainId !== env.QUORUM_CHAIN_ID) {
      throw new AppError(
        `Chain id mismatch: the node reports ${onChainId} but QUORUM_CHAIN_ID is ${env.QUORUM_CHAIN_ID}`,
        500,
        'CHAIN_ID_MISMATCH',
      );
    }

    // 2. The settlement contract still exists at the configured address.
    const code = await this.provider.getCode(env.VITTAGEM_CONTRACT_ADDRESS);
    if (code === '0x') {
      throw new AppError(
        `No contract found at VITTAGEM_CONTRACT_ADDRESS ${env.VITTAGEM_CONTRACT_ADDRESS} on chain ${onChainId}. ` +
          'If the Quorum network was rebuilt, redeploy the settlement contract and update VITTAGEM_CONTRACT_ADDRESS.',
        500,
        'SETTLEMENT_CONTRACT_MISSING',
      );
    }

    // 3. The operator can act as treasury (agent/compliance roles are self-granted later).
    let isTreasury = false;
    try {
      isTreasury = await this.contract.hasRole(await this.contract.TREASURY_ADMIN(), this.wallet.address);
    } catch {
      /* a read failure here is already covered by the bytecode check above */
    }
    if (!isTreasury) {
      logger.warn(
        `Operator ${this.wallet.address} does not hold TREASURY_ADMIN on ` +
          `${env.VITTAGEM_CONTRACT_ADDRESS} - mints will be rejected until it is granted.`,
      );
    }

    logger.info(
      `Blockchain preflight OK - chain ${onChainId} via ${env.QUORUM_RPC_URL}, ` +
        `settlement ${env.VITTAGEM_CONTRACT_ADDRESS}, operator ${this.wallet.address}` +
        (isTreasury ? ' (TREASURY_ADMIN)' : ''),
    );
  }

  /**
   * Grant the operator wallet the SETTLEMENT_AGENT and COMPLIANCE_OPERATOR roles
   * if it doesn't already have them. The operator is DEFAULT_ADMIN (deployer),
   * so it can grant roles to itself. Idempotent; runs at most once per process.
   */
  async ensureOperatorRoles(): Promise<void> {
    if (this.mock || this.rolesEnsured) return;
    try {
      const me = this.wallet.address;
      const [agentRole, complianceRole] = await Promise.all([
        this.contract.SETTLEMENT_AGENT(),
        this.contract.COMPLIANCE_OPERATOR(),
      ]);

      for (const [label, role] of [
        ['SETTLEMENT_AGENT', agentRole],
        ['COMPLIANCE_OPERATOR', complianceRole],
      ] as const) {
        const has = await this.contract.hasRole(role, me);
        if (!has) {
          logger.info(`Granting ${label} to operator ${me}`);
          const tx = await this.contract.assignRole(role, me, this.txOverrides());
          await tx.wait();
        }
      }
      this.rolesEnsured = true;
    } catch (error: any) {
      logger.error('Failed to ensure operator roles', error);
      throw new AppError(
        `Unable to configure settlement operator roles: ${error.shortMessage || error.message}`,
        500,
        'BLOCKCHAIN_ROLE_SETUP_FAILED',
      );
    }
  }

  async isPartnerApproved(partnerAddress: string): Promise<boolean> {
    if (this.mock) return true;
    return this.contract.approvedPartners(partnerAddress);
  }

  async registerPartner(partnerAddress: string, name: string): Promise<string> {
    if (this.mock) return `0xmock_register_partner_${Date.now()}`;
    try {
      const tx = await this.contract.registerPartner(partnerAddress, name, this.txOverrides());
      const receipt = await tx.wait();
      logger.info(`Registered partner ${partnerAddress} ("${name}") in block ${receipt.blockNumber}`);
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('registerPartner', error);
    }
  }

  async mint(referenceId: string, partnerAddress: string, amount: string, corridor: string): Promise<string> {
    logger.info(`MINT ${amount} -> ${partnerAddress} (ref=${referenceId}, corridor=${corridor})`);
    if (this.mock) return `0xmock_mint_tx_hash_${Date.now()}`;
    try {
      const tx = await this.contract.mintWithTreasuryApproval(
        this.toUnits(amount),
        partnerAddress,
        referenceId,
        corridor,
        this.txOverrides(),
      );
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('mint', error);
    }
  }

  async transfer(referenceId: string, toAddress: string, amount: string): Promise<string> {
    logger.info(`TRANSFER ref=${referenceId} -> ${toAddress} amount=${amount}`);
    if (this.mock) return `0xmock_transfer_tx_hash_${Date.now()}`;
    try {
      const tx = await this.contract.transfer(referenceId, toAddress, this.toUnits(amount), this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('transfer', error);
    }
  }

  async reconcile(referenceId: string): Promise<string> {
    logger.info(`RECONCILE ref=${referenceId}`);
    if (this.mock) return `0xmock_reconcile_tx_hash_${Date.now()}`;
    try {
      const tx = await this.contract.reconcile(referenceId, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('reconcile', error);
    }
  }

  async burn(referenceId: string): Promise<string> {
    logger.info(`BURN ref=${referenceId}`);
    if (this.mock) return `0xmock_burn_tx_hash_${Date.now()}`;
    try {
      const tx = await this.contract.burn(referenceId, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('burn', error);
    }
  }

  /** The address a redeemed settlement is moved to before being burned. */
  get redemptionSink(): string {
    return env.REDEMPTION_SINK_ADDRESS || this.wallet.address;
  }

  /**
   * Close a settlement after its off-chain fiat payout has been confirmed sent.
   *
   * The deployed contract cannot burn a still-MINTED settlement, so this walks it
   * through the required lifecycle before burning:
   *   MINTED -> transfer(to = redemption sink) -> TRANSFERRED
   *          -> reconcile()                     -> PAYOUT_CONFIRMED  ("funds sent")
   *          -> burn()                          -> CLOSED
   * Any already-advanced status is handled idempotently. Returns the burn tx hash.
   */
  async closeSettlementForWithdrawal(
    referenceId: string,
    opts: { releaseWithdrawalHold?: boolean } = {},
  ): Promise<string> {
    if (this.mock) return `0xmock_burn_tx_hash_${Date.now()}`;

    const sink = this.redemptionSink;
    if (!(await this.isPartnerApproved(sink))) {
      await this.registerPartner(sink, 'VittaGems Redemption');
    }

    let s = await this.getSettlement(referenceId);
    if (!s.exists) {
      throw new AppError(`Settlement ${referenceId} not found on-chain`, 404, 'SETTLEMENT_NOT_FOUND');
    }
    if (s.status === 'CLOSED') {
      throw new AppError(`Settlement ${referenceId} is already closed`, 409, 'SETTLEMENT_CLOSED');
    }
    // A hold placed by the DAO withdrawal flow is ours to lift once the DAO approves.
    // Any other hold (or a freeze) is a compliance action and must not be bypassed.
    if (s.status === 'ON_HOLD' && opts.releaseWithdrawalHold) {
      await this.releaseHold(referenceId);
      s = await this.getSettlement(referenceId);
    }
    if (s.status === 'ON_HOLD' || s.status === 'FROZEN') {
      throw new AppError(`Settlement ${referenceId} is ${s.status}; resolve compliance first`, 409, 'SETTLEMENT_BLOCKED');
    }

    if (s.status === 'MINTED') {
      // Transfer the exact settlement amount (contract requires an exact match).
      const amount = ethers.formatUnits(s.amount, this.decimals);
      await this.transfer(referenceId, sink, amount);
      s = await this.getSettlement(referenceId);
    }

    if (s.status === 'TRANSFERRED') {
      await this.reconcile(referenceId);
    }

    // Status is now PAYOUT_CONFIRMED (or was already) -> safe to burn.
    return this.burn(referenceId);
  }

  /**
   * Lock a settlement on-chain while a withdrawal is being verified. `ON_HOLD`
   * settlements cannot be transferred, so the funds cannot be spent twice.
   */
  async hold(referenceId: string, reason: string): Promise<string> {
    logger.info(`HOLD ref=${referenceId} (${reason})`);
    if (this.mock) return `0xmock_hold_tx_hash_${Date.now()}`;
    try {
      const tx = await this.contract.hold(referenceId, reason, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('hold', error);
    }
  }

  /**
   * Lift a withdrawal hold, returning the settlement to MINTED so its owner can use it again.
   * Returns null (no transaction) when the settlement is not on hold, so it is safe to call twice.
   */
  async releaseHold(referenceId: string): Promise<string | null> {
    logger.info(`RELEASE ref=${referenceId}`);
    if (this.mock) return `0xmock_release_tx_hash_${Date.now()}`;
    const s = await this.getSettlement(referenceId);
    if (s.status !== 'ON_HOLD') {
      logger.warn(`Release skipped: settlement ${referenceId} is ${s.status}, not ON_HOLD`);
      return null;
    }
    try {
      const tx = await this.contract.release(referenceId, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('release', error);
    }
  }

  async getSettlement(referenceId: string): Promise<OnChainSettlement> {
    if (this.mock) {
      return {
        referenceId,
        partner: ethers.ZeroAddress,
        amount: 0n,
        status: 'MINTED',
        createdAt: 0n,
        updatedAt: 0n,
        corridor: '',
        exists: true,
      };
    }
    const s = await this.contract.getSettlement(referenceId);
    return {
      referenceId: s.referenceId,
      partner: s.partner,
      amount: s.amount,
      status: SETTLEMENT_STATUS[Number(s.status)],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      corridor: s.corridor,
      exists: s.createdAt > 0n,
    };
  }

  async getOutstandingBalance(address: string): Promise<bigint> {
    if (this.mock) return 0n;
    return this.contract.getOutstandingBalance(address);
  }

  async getTransactionStatus(txHash: string): Promise<'PENDING' | 'CONFIRMED' | 'FAILED'> {
    if (this.mock) return 'CONFIRMED';
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) return 'PENDING';
      return receipt.status === 1 ? 'CONFIRMED' : 'FAILED';
    } catch (error: any) {
      logger.error(`Failed to read receipt for ${txHash}`, error);
      return 'PENDING';
    }
  }

  private wrap(op: string, error: any): AppError {
    const reason =
      error?.reason || error?.shortMessage || error?.info?.error?.message || error?.message || 'unknown error';

    // GoQuorum rejects transactions from accounts absent from permission-config.json.
    // Surface that distinctly - it is a network configuration problem, not a contract error.
    if (/does not have permission/i.test(String(reason))) {
      logger.error(`Blockchain ${op} rejected by network permissioning: ${reason}`);
      return new AppError(
        `Blockchain ${op} rejected: operator ${this.wallet.address} is not permissioned on this network. ` +
          'Add it to permission-config.json (GoQuorum Permissioning v2) and restart the nodes.',
        500,
        'ACCOUNT_NOT_PERMISSIONED',
      );
    }

    logger.error(`Blockchain ${op} failed: ${reason}`, error);
    return new AppError(`Blockchain ${op} transaction failed: ${reason}`, 500, 'BLOCKCHAIN_ERROR');
  }
}

// Export a singleton instance for simplicity
export const blockchainService = new BlockchainService();
