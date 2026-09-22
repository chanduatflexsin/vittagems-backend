import { ethers } from 'ethers';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

/**
 * Integration with the v2 (DAO-gated) settlement contract suite:
 *
 *   ProviderRegistry        - onboarded/KYC'd providers
 *   ProofOfPaymentRegistry  - off-chain bank proof anchored on-chain
 *   DAOGovernor             - proposals, votes, quorum, expiry
 *   SettlementToken (VGUSD) - permissioned ERC20; direct transfers are disabled
 *
 * Every value movement is two-phase:
 *
 *   request*  -> creates a DAO proposal            (backend, as RELAYER)
 *   castVote  -> DAO members vote                  (members sign themselves)
 *   execute*  -> mints/burns/moves once APPROVED   (backend, as RELAYER)
 *
 * The backend deliberately never votes: `DAOGovernor.castVote` is gated on
 * `msg.sender` holding DAO_MEMBER_ROLE, so members must hold their own keys.
 * That separation is the point of the DAO layer.
 */

export const PROPOSAL_STATE = ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'EXPIRED'] as const;
export type ProposalStateName = (typeof PROPOSAL_STATE)[number];

export const PROPOSAL_TYPE = ['DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER'] as const;
export type ProposalTypeName = (typeof PROPOSAL_TYPE)[number];

export interface OnChainProposal {
  id: string;
  proposalType: ProposalTypeName;
  targetProvider: string;
  amount: bigint;
  payloadHash: string;
  votesFor: number;
  votesAgainst: number;
  executed: boolean;
  expiry: Date;
  state: ProposalStateName;
  exists: boolean;
}

export class SettlementV2Service {
  private provider!: ethers.JsonRpcProvider;
  private wallet!: ethers.Wallet;
  private token!: ethers.Contract;
  private governor!: ethers.Contract;
  private providerRegistry!: ethers.Contract;
  private proofRegistry!: ethers.Contract;

  private readonly mock: boolean;
  private readonly decimals: number;

  static readonly TOKEN_ABI = [
    'function requestMint(address _providerId, uint256 _amount, bytes32 _proofOfPaymentId) external returns (uint256)',
    'function executeMint(uint256 _proposalId) external',
    'function requestBurn(address _providerId, uint256 _amount, bytes32 _payoutInstructionHash) external returns (uint256)',
    'function executeBurn(uint256 _proposalId) external',
    'function requestInternalTransfer(address _fromProvider, address _toProvider, uint256 _amount) external returns (uint256)',
    'function executeInternalTransfer(uint256 _proposalId, address _toProvider) external',
    'function balanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
    'function totalBurned() view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function hasRole(bytes32,address) view returns (bool)',
    'function RELAYER_ROLE() view returns (bytes32)',
    'function OWNER_ROLE() view returns (bytes32)',
    'event MintRequested(uint256 indexed proposalId, address indexed providerId, uint256 amount, bytes32 proofOfPaymentId)',
    'event BurnRequested(uint256 indexed proposalId, address indexed providerId, uint256 amount, bytes32 payoutInstructionHash)',
    'event InternalTransferRequested(uint256 indexed proposalId, address indexed fromProvider, address indexed toProvider, uint256 amount)',
    'event Minted(uint256 indexed proposalId, address indexed providerId, uint256 amount)',
    'event Burned(uint256 indexed proposalId, address indexed providerId, uint256 amount)',
    'event InternalTransferExecuted(uint256 indexed proposalId, address indexed fromProvider, address indexed toProvider, uint256 amount)',
  ];

  static readonly GOVERNOR_ABI = [
    'function getProposal(uint256) view returns (tuple(uint256 id, uint8 proposalType, address targetProvider, uint256 amount, bytes32 payloadHash, uint256 votesFor, uint256 votesAgainst, bool executed, uint256 expiry, uint8 state))',
    'function getProposalState(uint256) view returns (uint8)',
    'function proposalCount() view returns (uint256)',
    'function quorumThreshold() view returns (uint256)',
    'function votingPeriod() view returns (uint256)',
    'function hasVoted(uint256,address) view returns (bool)',
    'function hasRole(bytes32,address) view returns (bool)',
    'function DAO_MEMBER_ROLE() view returns (bytes32)',
    'function TOKEN_ROLE() view returns (bytes32)',
    'function grantRole(bytes32,address) external',
    'event ProposalCreated(uint256 indexed id, uint8 proposalType, address targetProvider, uint256 amount, bytes32 payloadHash, uint256 expiry)',
    'event VoteCast(uint256 indexed proposalId, address indexed voter, bool support)',
    'event ProposalExecuted(uint256 indexed proposalId)',
  ];

  static readonly PROVIDER_REGISTRY_ABI = [
    'function onboardProvider(address _wallet, string _name, bool _kycApproved) external',
    'function offboardProvider(address _wallet) external',
    'function updateKYCStatus(address _wallet, bool _kycApproved) external',
    'function isProviderApproved(address) view returns (bool)',
    'function providers(address) view returns (bool isRegistered, bool kycApproved, address wallet, string name)',
    'event ProviderOnboarded(address indexed wallet, string name)',
  ];

  static readonly PROOF_REGISTRY_ABI = [
    'function submitProof(bytes32 _referenceId, bytes32 _documentHash) external',
    'function linkProofToProposal(bytes32 _referenceId, uint256 _proposalId) external',
    'function isProofValid(bytes32) view returns (bool)',
    'function proofs(bytes32) view returns (bytes32 documentHash, address submitter, uint256 timestamp, bool isUsed, uint256 linkedProposalId)',
    'event ProofSubmitted(bytes32 indexed referenceId, bytes32 documentHash, address submitter)',
  ];

  constructor() {
    this.mock = env.BLOCKCHAIN_MODE === 'mock';
    this.decimals = env.SETTLEMENT_TOKEN_DECIMALS;

    if (this.mock) {
      const p = new ethers.JsonRpcProvider(env.QUORUM_RPC_URL);
      this.provider = p;
      this.wallet = new ethers.Wallet(env.BLOCKCHAIN_PRIVATE_KEY, p);
      logger.warn('SettlementV2Service running in MOCK mode - no transactions will be broadcast');
      return;
    }

    const missing = (['SETTLEMENT_TOKEN_ADDRESS', 'DAO_GOVERNOR_ADDRESS', 'PROVIDER_REGISTRY_ADDRESS', 'PROOF_REGISTRY_ADDRESS'] as const)
      .filter((k) => !env[k]);
    if (missing.length) {
      throw new AppError(
        `SETTLEMENT_VERSION=v2 requires these addresses in the environment: ${missing.join(', ')}`,
        500,
        'V2_ADDRESSES_MISSING',
      );
    }

    const network = new ethers.Network('quorum', BigInt(env.QUORUM_CHAIN_ID));
    this.provider = new ethers.JsonRpcProvider(env.QUORUM_RPC_URL, network, { staticNetwork: network });
    this.wallet = new ethers.Wallet(env.BLOCKCHAIN_PRIVATE_KEY, this.provider);

    this.token = new ethers.Contract(env.SETTLEMENT_TOKEN_ADDRESS!, SettlementV2Service.TOKEN_ABI, this.wallet);
    this.governor = new ethers.Contract(env.DAO_GOVERNOR_ADDRESS!, SettlementV2Service.GOVERNOR_ABI, this.wallet);
    this.providerRegistry = new ethers.Contract(env.PROVIDER_REGISTRY_ADDRESS!, SettlementV2Service.PROVIDER_REGISTRY_ABI, this.wallet);
    this.proofRegistry = new ethers.Contract(env.PROOF_REGISTRY_ADDRESS!, SettlementV2Service.PROOF_REGISTRY_ABI, this.wallet);
  }

  get signerAddress(): string {
    return this.wallet.address;
  }

  /** Deterministically map a business reference (invoice/deposit id) to the bytes32 the registry keys on. */
  static referenceToBytes32(referenceId: string): string {
    return ethers.id(referenceId);
  }

  /** Hash arbitrary proof material (bank statement text, PDF bytes, JSON) for on-chain anchoring. */
  static hashDocument(content: string): string {
    return ethers.id(content);
  }

  private toUnits(amount: string): bigint {
    return ethers.parseUnits(amount, this.decimals);
  }

  private txOverrides(): ethers.Overrides {
    return { gasPrice: 0, type: 0 };
  }

  /**
   * A transaction's Solidity return value is not available from a receipt, so the
   * proposal id must be recovered from the emitted event.
   */
  private proposalIdFromReceipt(receipt: ethers.TransactionReceipt, eventName: string): string {
    for (const log of receipt.logs) {
      try {
        const parsed = this.token.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === eventName) return parsed.args.proposalId.toString();
      } catch {
        /* log belongs to another contract - ignore */
      }
    }
    throw new AppError(
      `Transaction ${receipt.hash} did not emit ${eventName}; cannot determine the proposal id`,
      500,
      'PROPOSAL_ID_NOT_FOUND',
    );
  }

  // ── Providers ──────────────────────────────────────────────────

  async isProviderApproved(wallet: string): Promise<boolean> {
    if (this.mock) return true;
    return this.providerRegistry.isProviderApproved(wallet);
  }

  async onboardProvider(wallet: string, name: string, kycApproved = true): Promise<string> {
    if (this.mock) return `0xmock_onboard_${Date.now()}`;
    try {
      const tx = await this.providerRegistry.onboardProvider(wallet, name, kycApproved, this.txOverrides());
      await tx.wait();
      logger.info(`Onboarded provider ${wallet} ("${name}") kyc=${kycApproved}`);
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('onboardProvider', error);
    }
  }

  // ── Proof of payment ───────────────────────────────────────────

  async submitProof(referenceId: string, documentHash: string): Promise<string> {
    if (this.mock) return `0xmock_proof_${Date.now()}`;
    try {
      const tx = await this.proofRegistry.submitProof(
        SettlementV2Service.referenceToBytes32(referenceId),
        documentHash,
        this.txOverrides(),
      );
      await tx.wait();
      logger.info(`Proof submitted for reference ${referenceId}`);
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('submitProof', error);
    }
  }

  async isProofValid(referenceId: string): Promise<boolean> {
    if (this.mock) return true;
    return this.proofRegistry.isProofValid(SettlementV2Service.referenceToBytes32(referenceId));
  }

  // ── Phase 1: request (creates a DAO proposal) ──────────────────

  async requestMint(providerAddress: string, amount: string, referenceId: string): Promise<string> {
    logger.info(`v2 requestMint provider=${providerAddress} amount=${amount} ref=${referenceId}`);
    if (this.mock) return `${Date.now()}`;
    try {
      const tx = await this.token.requestMint(
        providerAddress,
        this.toUnits(amount),
        SettlementV2Service.referenceToBytes32(referenceId),
        this.txOverrides(),
      );
      return this.proposalIdFromReceipt(await tx.wait(), 'MintRequested');
    } catch (error: any) {
      throw this.wrap('requestMint', error);
    }
  }

  async requestBurn(providerAddress: string, amount: string, payoutInstructionHash: string): Promise<string> {
    logger.info(`v2 requestBurn provider=${providerAddress} amount=${amount}`);
    if (this.mock) return `${Date.now()}`;
    try {
      const tx = await this.token.requestBurn(
        providerAddress,
        this.toUnits(amount),
        payoutInstructionHash,
        this.txOverrides(),
      );
      return this.proposalIdFromReceipt(await tx.wait(), 'BurnRequested');
    } catch (error: any) {
      throw this.wrap('requestBurn', error);
    }
  }

  async requestInternalTransfer(fromProvider: string, toProvider: string, amount: string): Promise<string> {
    logger.info(`v2 requestInternalTransfer ${fromProvider} -> ${toProvider} amount=${amount}`);
    if (this.mock) return `${Date.now()}`;
    try {
      const tx = await this.token.requestInternalTransfer(
        fromProvider,
        toProvider,
        this.toUnits(amount),
        this.txOverrides(),
      );
      return this.proposalIdFromReceipt(await tx.wait(), 'InternalTransferRequested');
    } catch (error: any) {
      throw this.wrap('requestInternalTransfer', error);
    }
  }

  // ── Phase 2: execute (only once the DAO has approved) ──────────

  async executeMint(proposalId: string): Promise<string> {
    logger.info(`v2 executeMint proposal=${proposalId}`);
    if (this.mock) return `0xmock_execute_mint_${Date.now()}`;
    await this.assertApproved(proposalId, 'DEPOSIT');
    try {
      const tx = await this.token.executeMint(proposalId, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('executeMint', error);
    }
  }

  async executeBurn(proposalId: string): Promise<string> {
    logger.info(`v2 executeBurn proposal=${proposalId}`);
    if (this.mock) return `0xmock_execute_burn_${Date.now()}`;
    await this.assertApproved(proposalId, 'WITHDRAWAL');
    try {
      const tx = await this.token.executeBurn(proposalId, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('executeBurn', error);
    }
  }

  async executeInternalTransfer(proposalId: string, toProvider: string): Promise<string> {
    logger.info(`v2 executeInternalTransfer proposal=${proposalId} to=${toProvider}`);
    if (this.mock) return `0xmock_execute_transfer_${Date.now()}`;
    await this.assertApproved(proposalId, 'INTERNAL_TRANSFER');
    try {
      const tx = await this.token.executeInternalTransfer(proposalId, toProvider, this.txOverrides());
      await tx.wait();
      return tx.hash;
    } catch (error: any) {
      throw this.wrap('executeInternalTransfer', error);
    }
  }

  /**
   * Fail with a clear reason before spending a transaction on a proposal the
   * contract will reject anyway (still pending, rejected, expired, or already
   * executed at the governor level).
   */
  private async assertApproved(proposalId: string, expected: ProposalTypeName): Promise<void> {
    const p = await this.getProposal(proposalId);
    if (!p.exists) {
      throw new AppError(`Proposal ${proposalId} does not exist on-chain`, 404, 'PROPOSAL_NOT_FOUND');
    }
    if (p.proposalType !== expected) {
      throw new AppError(
        `Proposal ${proposalId} is a ${p.proposalType} proposal, expected ${expected}`,
        409,
        'PROPOSAL_TYPE_MISMATCH',
      );
    }
    if (p.state !== 'APPROVED') {
      throw new AppError(
        `Proposal ${proposalId} is ${p.state}, not APPROVED (${p.votesFor} for / ${p.votesAgainst} against)`,
        409,
        'PROPOSAL_NOT_APPROVED',
      );
    }
  }

  // ── Reads ──────────────────────────────────────────────────────

  async getProposal(proposalId: string): Promise<OnChainProposal> {
    if (this.mock) {
      return {
        id: proposalId,
        proposalType: 'DEPOSIT',
        targetProvider: ethers.ZeroAddress,
        amount: 0n,
        payloadHash: ethers.ZeroHash,
        votesFor: 0,
        votesAgainst: 0,
        executed: false,
        expiry: new Date(),
        state: 'APPROVED',
        exists: true,
      };
    }
    const p = await this.governor.getProposal(proposalId);
    // getProposalState() also folds in expiry that the stored state may not reflect yet.
    const liveState = Number(await this.governor.getProposalState(proposalId));
    return {
      id: p.id.toString(),
      proposalType: PROPOSAL_TYPE[Number(p.proposalType)],
      targetProvider: p.targetProvider,
      amount: p.amount,
      payloadHash: p.payloadHash,
      votesFor: Number(p.votesFor),
      votesAgainst: Number(p.votesAgainst),
      executed: p.executed,
      expiry: new Date(Number(p.expiry) * 1000),
      state: PROPOSAL_STATE[liveState],
      exists: p.id > 0n,
    };
  }

  async getQuorumThreshold(): Promise<number> {
    if (this.mock) return 3;
    return Number(await this.governor.quorumThreshold());
  }

  async getBalance(address: string): Promise<bigint> {
    if (this.mock) return 0n;
    return this.token.balanceOf(address);
  }

  async getSupply(): Promise<{ totalSupply: bigint; totalBurned: bigint }> {
    if (this.mock) return { totalSupply: 0n, totalBurned: 0n };
    const [totalSupply, totalBurned] = await Promise.all([this.token.totalSupply(), this.token.totalBurned()]);
    return { totalSupply, totalBurned };
  }

  formatAmount(units: bigint): string {
    return ethers.formatUnits(units, this.decimals);
  }

  // ── Startup checks ─────────────────────────────────────────────

  async preflight(): Promise<void> {
    if (this.mock) {
      logger.warn('v2 preflight skipped - BLOCKCHAIN_MODE=mock');
      return;
    }

    const onChainId = Number((await this.provider.getNetwork()).chainId);
    if (onChainId !== env.QUORUM_CHAIN_ID) {
      throw new AppError(
        `Chain id mismatch: node reports ${onChainId}, QUORUM_CHAIN_ID is ${env.QUORUM_CHAIN_ID}`,
        500,
        'CHAIN_ID_MISMATCH',
      );
    }

    const targets: Array<[string, string]> = [
      ['SettlementToken', env.SETTLEMENT_TOKEN_ADDRESS!],
      ['DAOGovernor', env.DAO_GOVERNOR_ADDRESS!],
      ['ProviderRegistry', env.PROVIDER_REGISTRY_ADDRESS!],
      ['ProofOfPaymentRegistry', env.PROOF_REGISTRY_ADDRESS!],
    ];
    for (const [name, address] of targets) {
      if ((await this.provider.getCode(address)) === '0x') {
        throw new AppError(
          `No contract found for ${name} at ${address} on chain ${onChainId}. ` +
            'Deploy the v2 suite and update the address in the environment.',
          500,
          'V2_CONTRACT_MISSING',
        );
      }
    }

    // The backend acts as relayer: it must be able to call request*/execute*.
    let canRelay = false;
    try {
      const [relayerRole, ownerRole] = await Promise.all([this.token.RELAYER_ROLE(), this.token.OWNER_ROLE()]);
      const [isRelayer, isOwner] = await Promise.all([
        this.token.hasRole(relayerRole, this.wallet.address),
        this.token.hasRole(ownerRole, this.wallet.address),
      ]);
      canRelay = isRelayer || isOwner;
    } catch {
      /* handled by the warning below */
    }
    if (!canRelay) {
      logger.warn(
        `Operator ${this.wallet.address} holds neither RELAYER_ROLE nor OWNER_ROLE on the SettlementToken - ` +
          'mint/burn/transfer requests will revert with NotAuthorized.',
      );
    }

    const quorum = await this.getQuorumThreshold();
    logger.info(
      `v2 preflight OK - chain ${onChainId}, token ${env.SETTLEMENT_TOKEN_ADDRESS}, ` +
        `governor ${env.DAO_GOVERNOR_ADDRESS} (quorum ${quorum}), operator ${this.wallet.address}` +
        (canRelay ? ' (relayer)' : ''),
    );
  }

  private wrap(op: string, error: any): AppError {
    const reason =
      error?.reason || error?.shortMessage || error?.info?.error?.message || error?.message || 'unknown error';

    if (/does not have permission/i.test(String(reason))) {
      return new AppError(
        `v2 ${op} rejected: operator ${this.wallet.address} is not permissioned on this network.`,
        500,
        'ACCOUNT_NOT_PERMISSIONED',
      );
    }
    // Map the suite's custom errors onto something actionable.
    if (/NotAuthorized/.test(String(reason))) {
      return new AppError(
        `v2 ${op} rejected: caller lacks RELAYER_ROLE/OWNER_ROLE, or the proof of payment is missing or already used.`,
        403,
        'V2_NOT_AUTHORIZED',
      );
    }
    if (/ProviderNotApproved/.test(String(reason))) {
      return new AppError(`v2 ${op} rejected: provider is not registered/KYC-approved.`, 409, 'PROVIDER_NOT_APPROVED');
    }
    if (/AmountMismatch/.test(String(reason))) {
      return new AppError(`v2 ${op} rejected: provider balance is lower than the requested amount.`, 409, 'AMOUNT_MISMATCH');
    }
    if (/InvalidProposalState/.test(String(reason))) {
      return new AppError(
        `v2 ${op} rejected: the proposal is not in an executable state (already executed, expired, or not approved).`,
        409,
        'INVALID_PROPOSAL_STATE',
      );
    }

    logger.error(`v2 ${op} failed: ${reason}`, error);
    return new AppError(`v2 ${op} failed: ${reason}`, 500, 'BLOCKCHAIN_ERROR');
  }
}

/** Lazily constructed so v1 deployments never require the v2 addresses. */
let _instance: SettlementV2Service | null = null;
export const settlementV2 = (): SettlementV2Service => {
  if (!_instance) _instance = new SettlementV2Service();
  return _instance;
};
