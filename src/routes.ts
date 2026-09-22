import { Router, raw } from 'express';
import { env } from './config/env';
import { MintController } from './modules/mint/mint.controller';
import { TransferController } from './modules/transfers/transfer.controller';
import { WithdrawalController } from './modules/withdrawals/withdrawal.controller';
import { ClientController } from './modules/clients/client.controller';
import { DepositController } from './modules/deposits/deposit.controller';
import { ProposalController } from './modules/proposals/proposal.controller';
import { DaoController, authenticateDaoMember } from './modules/dao/dao.controller';
import { WalletController, DocumentController } from './modules/wallets/wallet.controller';
import { authenticateApiKey, requirePermissions, requireBlockchainAccess } from './middleware/authMiddleware';
import { requireIdempotency } from './middleware/idempotency';

const router = Router();

// Proof documents are uploaded as the raw request body (the file's own Content-Type,
// name in X-File-Name), so no multipart parser is needed and nothing is base64-inflated.
const rawUpload = raw({ type: () => true, limit: `${env.PROOF_MAX_MB}mb` });

// ==========================================
// ADMIN / CLIENT SETUP ROUTES (Mocked as public for ease of testing)
// ==========================================

/**
 * @openapi
 * /clients/register:
 *   post:
 *     tags: [Clients]
 *     summary: Register a client and issue an API key
 *     description: >
 *       Public (for ease of testing). Returns the raw API key exactly once — save it.
 *       Register a `blockchainAddress` so the client can call mint/transfer/withdraw.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ClientRegisterRequest'
 *     responses:
 *       201:
 *         description: Client created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/ClientRegisterResponse' }
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post('/clients/register', ClientController.registerClient);

// ==========================================
// CLIENT INFO ROUTES
// ==========================================

/**
 * @openapi
 * /client:
 *   get:
 *     tags: [Clients]
 *     summary: Get the authenticated client's details
 *     responses:
 *       200:
 *         description: Client details (including blockchain accounts and API keys)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { type: object }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get(
  '/client',
  authenticateApiKey,
  ClientController.getClientDetails
);

// ==========================================
// DEPOSIT ROUTES (Mocking webhook from bank)
// ==========================================

/**
 * @openapi
 * /deposits:
 *   post:
 *     tags: [Deposits]
 *     summary: Register a (mock-verified) fiat deposit
 *     description: >
 *       Simulates a bank/payment-gateway webhook confirming fiat receipt. The deposit is
 *       created already VERIFIED and its `referenceId` becomes the on-chain settlement key.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DepositRequest'
 *     responses:
 *       201:
 *         description: Deposit verified and ready for minting
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     depositId: { type: string }
 *                     referenceId: { type: string }
 *                     status: { type: string, example: VERIFIED }
 *                     message: { type: string }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post(
  '/deposits',
  authenticateApiKey,
  // requirePermissions(['DEPOSIT_WRITE']),
  DepositController.registerDepositMock
);

// ==========================================
// MINT ROUTES
// ==========================================

/**
 * @openapi
 * /mint:
 *   post:
 *     tags: [Mint]
 *     summary: Mint settlement value against a verified deposit
 *     description: >
 *       Requires the `MINT` scope, an active blockchain account, and an `Idempotency-Key`
 *       header. The amount is tied to the verified deposit, not the request body. Queued for
 *       on-chain processing (poll GET /mint/{id}).
 *     parameters:
 *       - $ref: '#/components/parameters/IdempotencyKey'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/MintRequest'
 *     responses:
 *       202:
 *         description: Mint accepted and queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/AcceptedTransaction' }
 *       200:
 *         description: Duplicate request (existing transaction returned)
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post(
  '/mint',
  authenticateApiKey,
  requirePermissions(['MINT']),
  requireBlockchainAccess,
  requireIdempotency,
  MintController.mintTokens
);

/**
 * @openapi
 * /mint/{id}:
 *   get:
 *     tags: [Mint]
 *     summary: Get a mint transaction status
 *     description: Requires the `TRANSACTION_READ` scope.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transaction status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/TransactionStatus' }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/mint/:id',
  authenticateApiKey,
  requirePermissions(['TRANSACTION_READ']),
  MintController.getMintStatus
);

// ==========================================
// TRANSFER ROUTES
// ==========================================

/**
 * @openapi
 * /transfers:
 *   post:
 *     tags: [Transfers]
 *     summary: Transfer a settlement to another approved partner
 *     description: >
 *       Requires the `TRANSFER` scope, an active blockchain account, and an `Idempotency-Key`
 *       header. Moves the whole MINTED settlement identified by `referenceId` to `toAddress`.
 *     parameters:
 *       - $ref: '#/components/parameters/IdempotencyKey'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TransferRequest'
 *     responses:
 *       202:
 *         description: Transfer accepted and queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/AcceptedTransaction' }
 *       200:
 *         description: Duplicate request (existing transaction returned)
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post(
  '/transfers',
  authenticateApiKey,
  requirePermissions(['TRANSFER']),
  requireBlockchainAccess,
  requireIdempotency,
  TransferController.initiateTransfer
);

/**
 * @openapi
 * /transfers/{id}:
 *   get:
 *     tags: [Transfers]
 *     summary: Get a transfer transaction status
 *     description: Requires the `TRANSACTION_READ` scope.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transaction status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data: { $ref: '#/components/schemas/TransactionStatus' }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/transfers/:id',
  authenticateApiKey,
  requirePermissions(['TRANSACTION_READ']),
  TransferController.getTransferStatus
);

// ==========================================
// WITHDRAWAL ROUTES
// ==========================================

/**
 * @openapi
 * /withdrawals:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Request a withdrawal (redeem a settlement to fiat)
 *     description: >
 *       Requires the `WITHDRAW` scope, an active blockchain account, and an `Idempotency-Key`
 *       header. Creates a REQUESTED withdrawal plus a PENDING burn. The on-chain burn only
 *       runs after payout confirmation (POST /withdrawals/{id}/approve).
 *     parameters:
 *       - $ref: '#/components/parameters/IdempotencyKey'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/WithdrawalRequest'
 *     responses:
 *       202:
 *         description: Withdrawal requested
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     withdrawalId: { type: string }
 *                     status: { type: string, example: REQUESTED }
 *                     message: { type: string }
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
router.post(
  '/withdrawals',
  authenticateApiKey,
  requirePermissions(['WITHDRAW']),
  requireBlockchainAccess,
  requireIdempotency,
  WithdrawalController.requestWithdrawal
);

/**
 * @openapi
 * /withdrawals/{id}:
 *   get:
 *     tags: [Withdrawals]
 *     summary: Get a withdrawal status
 *     description: Requires the `WITHDRAW_STATUS` scope.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Withdrawal + linked burn status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     withdrawalId: { type: string }
 *                     status: { type: string, example: BURN_PENDING }
 *                     burnTransactionStatus: { type: string, nullable: true }
 *                     blockchainTxHash: { type: string, nullable: true }
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/withdrawals/:id',
  authenticateApiKey,
  requirePermissions(['WITHDRAW_STATUS']),
  WithdrawalController.getWithdrawalStatus
);

/**
 * @openapi
 * /withdrawals/{id}/payout-proof:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Report the off-chain payout for DAO verification
 *     description: >
 *       DAO verification mode. After the withdrawal's funds are LOCKED on-chain, pay the
 *       customer from your bank and submit that transfer's reference here. DAO members then
 *       verify it and vote; approval burns the locked funds, rejection releases them back.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [payoutReference]
 *             properties:
 *               payoutReference: { type: string, example: 'UTR-HDFC-778812' }
 *               notes: { type: string, example: 'IMPS to Alice Sharma' }
 *     responses:
 *       200:
 *         description: Payout reference recorded; awaiting DAO votes
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post(
  '/withdrawals/:id/payout-proof',
  authenticateApiKey,
  requirePermissions(['WITHDRAW']),
  WithdrawalController.submitPayoutProof
);

/**
 * @openapi
 * /withdrawals/{id}/extend:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Flag a bank delay to extend the payout window
 *     description: >
 *       DAO verification mode. Adds DAO_WITHDRAWAL_EXTENSION_MINUTES to the window, up to
 *       DAO_MAX_EXTENSIONS times. Without it, an unverified withdrawal expires and the locked
 *       funds are released back.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, example: 'Bank batch payout scheduled for 4pm' }
 *     responses:
 *       200:
 *         description: Window extended
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post(
  '/withdrawals/:id/extend',
  authenticateApiKey,
  requirePermissions(['WITHDRAW']),
  WithdrawalController.requestExtension
);

/**
 * @openapi
 * /withdrawals/{id}/approve:
 *   post:
 *     tags: [Withdrawals]
 *     summary: Confirm fiat payout sent and close the settlement on-chain
 *     description: >
 *       Admin action (public here for testing). Call ONLY after the off-chain fiat payout has
 *       actually been sent. Queues the burn, which walks the settlement
 *       MINTED → transfer → reconcile → burn → CLOSED and marks the withdrawal SETTLED.
 *     security: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payout confirmed; settlement closure initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     withdrawalId: { type: string }
 *                     status: { type: string, example: BURN_PENDING }
 *                     message: { type: string }
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post(
  '/withdrawals/:id/approve',
  // requireAdminAuth,
  WithdrawalController.approveWithdrawal
);

// ==========================================
// DAO PROPOSAL ROUTES (v2 settlement only)
// ==========================================

/**
 * @openapi
 * /proposals:
 *   get:
 *     tags: [Proposals]
 *     summary: List DAO proposals for the authenticated client
 *     description: >
 *       Only available when the deployment runs the v2 (DAO-gated) settlement contracts.
 *       Voting happens on-chain: DAO members sign their own votes, so there is no vote
 *       endpoint here.
 *     parameters:
 *       - name: state
 *         in: query
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED, EXECUTED, EXPIRED] }
 *     responses:
 *       200:
 *         description: Proposals
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get(
  '/proposals',
  authenticateApiKey,
  requirePermissions(['TRANSACTION_READ']),
  ProposalController.listProposals
);

/**
 * @openapi
 * /proposals/{id}:
 *   get:
 *     tags: [Proposals]
 *     summary: Get a DAO proposal, refreshed from the chain
 *     description: Returns current vote tallies, quorum requirement and on-chain state.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proposal state
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get(
  '/proposals/:id',
  authenticateApiKey,
  requirePermissions(['TRANSACTION_READ']),
  ProposalController.getProposal
);

/**
 * @openapi
 * /proposals/{id}/execute:
 *   post:
 *     tags: [Proposals]
 *     summary: Execute an APPROVED proposal on-chain
 *     description: >
 *       Mints, burns or moves value for a proposal the DAO has already approved.
 *       Rejected if the proposal is still PENDING, was REJECTED, has EXPIRED, or was
 *       already executed.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Executed
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post(
  '/proposals/:id/execute',
  authenticateApiKey,
  requirePermissions(['MINT']),
  ProposalController.executeProposal
);

// ==========================================
// WALLET WHITELIST (client side)
// ==========================================

/**
 * @openapi
 * /wallets:
 *   post:
 *     tags: [Wallets]
 *     summary: Register a wallet for whitelisting
 *     description: >
 *       Nothing is minted to, transferred to, or withdrawn from an address that is not
 *       whitelisted and ACTIVE. The wallet starts PENDING; a DAO member must approve it.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [address, label]
 *             properties:
 *               address: { type: string, example: '0x0133F71677B3de040CA09c63F285DE5EDD3912Be' }
 *               label: { type: string, example: 'Acme settlement wallet' }
 *     responses:
 *       201:
 *         description: Wallet registered, awaiting DAO approval
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 *   get:
 *     tags: [Wallets]
 *     summary: List this client's wallets and their whitelist status
 *     responses:
 *       200:
 *         description: Wallets
 */
router.post('/wallets', authenticateApiKey, WalletController.request);
router.get('/wallets', authenticateApiKey, WalletController.list);

// ==========================================
// PROOF DOCUMENTS
// ==========================================

/**
 * @openapi
 * /deposits/{id}/documents:
 *   post:
 *     tags: [Documents]
 *     summary: Attach proof of the incoming payment
 *     description: >
 *       Send the file as the raw request body with its own Content-Type (image, PDF,
 *       text/CSV, Word or Excel) and the file name in X-File-Name. DAO members see it
 *       next to the bank reference when verifying the deposit.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Deposit id
 *         schema: { type: string }
 *       - name: X-File-Name
 *         in: header
 *         schema: { type: string, example: 'bank-statement.pdf' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/pdf:
 *           schema: { type: string, format: binary }
 *         image/png:
 *           schema: { type: string, format: binary }
 *         image/jpeg:
 *           schema: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Document stored
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.post('/deposits/:id/documents', authenticateApiKey, rawUpload, DocumentController.uploadForDeposit);

/**
 * @openapi
 * /withdrawals/{id}/documents:
 *   post:
 *     tags: [Documents]
 *     summary: Attach proof of the outgoing payout
 *     description: Same upload format as deposit documents; shown to the DAO with the payout reference.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: X-File-Name
 *         in: header
 *         schema: { type: string, example: 'payout-receipt.png' }
 *     requestBody:
 *       required: true
 *       content:
 *         application/pdf:
 *           schema: { type: string, format: binary }
 *         image/png:
 *           schema: { type: string, format: binary }
 *     responses:
 *       201:
 *         description: Document stored
 */
router.post('/withdrawals/:id/documents', authenticateApiKey, rawUpload, DocumentController.uploadForWithdrawal);

/**
 * @openapi
 * /documents/{id}:
 *   get:
 *     tags: [Documents]
 *     summary: Download one of your own uploaded documents
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The file
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/documents/:id', authenticateApiKey, DocumentController.downloadAsClient);

// ==========================================
// DAO VERIFICATION ROUTES
// ==========================================

/**
 * @openapi
 * /dao/config:
 *   get:
 *     tags: [DAO]
 *     summary: DAO verification settings
 *     security: []
 *     responses:
 *       200:
 *         description: Quorum, active member count and time windows
 */
router.get('/dao/config', DaoController.config);

/**
 * @openapi
 * /dao/members:
 *   post:
 *     tags: [DAO]
 *     summary: Register a DAO member (bootstrap)
 *     description: >
 *       Public for the demo; in production this must be an admin-only action.
 *       Returns the member token once - send it as the X-DAO-Token header.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: 'Priya (Compliance)' }
 *     responses:
 *       201:
 *         description: Member created with a one-time token
 */
router.post('/dao/members', DaoController.registerMember);

/**
 * @openapi
 * /dao/me:
 *   get:
 *     tags: [DAO]
 *     summary: The authenticated DAO member
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *     responses:
 *       200:
 *         description: Member
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/dao/me', authenticateDaoMember, DaoController.me);

/**
 * @openapi
 * /dao/members/me/deactivate:
 *   post:
 *     tags: [DAO]
 *     summary: Deactivate the calling member
 *     description: A member stops counting toward the DAO and its token stops working.
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *     responses:
 *       200:
 *         description: Deactivated
 */
router.post('/dao/members/me/deactivate', authenticateDaoMember, DaoController.deactivateSelf);

/**
 * @openapi
 * /dao/proposals:
 *   get:
 *     tags: [DAO]
 *     summary: Verification queue
 *     description: Every deposit and withdrawal awaiting (or past) DAO verification, across all clients.
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: state
 *         in: query
 *         schema: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED, EXECUTED] }
 *       - name: type
 *         in: query
 *         schema: { type: string, enum: [DEPOSIT, WITHDRAWAL] }
 *     responses:
 *       200:
 *         description: Proposals with evidence, votes, window and timeline
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/dao/proposals', authenticateDaoMember, DaoController.listProposals);

/**
 * @openapi
 * /dao/proposals/{id}:
 *   get:
 *     tags: [DAO]
 *     summary: One verification request with its evidence and timeline
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Proposal
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/dao/proposals/:id', authenticateDaoMember, DaoController.getProposal);

/**
 * @openapi
 * /dao/proposals/{id}/votes:
 *   post:
 *     tags: [DAO]
 *     summary: Vote to approve or reject
 *     description: >
 *       One vote per member. DAO_QUORUM approvals verify a deposit (releasing its mint) or a
 *       withdrawal payout (burning the locked funds). DAO_QUORUM rejections - or fewer, once
 *       approval is no longer possible - reject it: a deposit mints nothing, a withdrawal's
 *       funds are released back. A rejection requires a comment. Withdrawals can only be voted on after
 *       the client submits the payout reference.
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [APPROVE, REJECT] }
 *               comment: { type: string, example: 'UTR matches bank statement line 14' }
 *     responses:
 *       200:
 *         description: Vote recorded; returns the updated proposal
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post('/dao/proposals/:id/votes', authenticateDaoMember, DaoController.vote);

/**
 * @openapi
 * /dao/proposals/{id}/extend:
 *   post:
 *     tags: [DAO]
 *     summary: Extend a verification window
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, example: 'Bank confirmed payout is in the next batch' }
 *     responses:
 *       200:
 *         description: Window extended
 *       409:
 *         $ref: '#/components/responses/Conflict'
 */
router.post('/dao/proposals/:id/extend', authenticateDaoMember, DaoController.extend);

/**
 * @openapi
 * /dao/wallets:
 *   get:
 *     tags: [DAO]
 *     summary: Wallets awaiting (or past) whitelist review
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [PENDING, ACTIVE, REJECTED, REVOKED] }
 *     responses:
 *       200:
 *         description: Wallets
 */
router.get('/dao/wallets', authenticateDaoMember, WalletController.listForDao);

/**
 * @openapi
 * /dao/wallets/{id}/approve:
 *   post:
 *     tags: [DAO]
 *     summary: Whitelist a wallet
 *     description: Makes the wallet ACTIVE so settlement value may be minted to it. It is registered on-chain as a partner the first time it is used.
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Wallet is ACTIVE
 */
router.post('/dao/wallets/:id/approve', authenticateDaoMember, WalletController.approve);

/**
 * @openapi
 * /dao/wallets/{id}/reject:
 *   post:
 *     tags: [DAO]
 *     summary: Refuse a pending wallet (reason required)
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, example: 'KYC documents do not match the account holder' }
 *     responses:
 *       200:
 *         description: Wallet is REJECTED
 */
router.post('/dao/wallets/:id/reject', authenticateDaoMember, WalletController.reject);

/**
 * @openapi
 * /dao/wallets/{id}/revoke:
 *   post:
 *     tags: [DAO]
 *     summary: Revoke an active wallet (reason required)
 *     description: Takes effect immediately, including for jobs already queued but not yet signed.
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, example: 'Sanctions screening hit' }
 *     responses:
 *       200:
 *         description: Wallet is REVOKED
 */
router.post('/dao/wallets/:id/revoke', authenticateDaoMember, WalletController.revoke);

/**
 * @openapi
 * /dao/documents/{id}:
 *   get:
 *     tags: [DAO]
 *     summary: Open a proof document attached to a request
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/DaoToken'
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The file
 */
router.get('/dao/documents/:id', authenticateDaoMember, DocumentController.downloadAsDao);

export default router;
