import { Router } from 'express';
import { MintController } from './modules/mint/mint.controller';
import { TransferController } from './modules/transfers/transfer.controller';
import { WithdrawalController } from './modules/withdrawals/withdrawal.controller';
import { ClientController } from './modules/clients/client.controller';
import { DepositController } from './modules/deposits/deposit.controller';
import { authenticateApiKey, requirePermissions, requireBlockchainAccess } from './middleware/authMiddleware';
import { requireIdempotency } from './middleware/idempotency';

const router = Router();

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

export default router;
