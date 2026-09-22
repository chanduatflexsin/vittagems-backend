import swaggerJSDoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'VittaGems Settlement API',
      version: '1.0.0',
      description: [
        'API bridge between third-party payment platforms, the VittaGems API, and the',
        'VittaGems Quorum settlement chain.',
        '',
        '### How to test manually',
        '1. **POST /clients/register** — create a client. Copy the returned `apiKey` (shown once)',
        '   and, ideally, register a `blockchainAddress` (required for mint/transfer/withdraw).',
        '2. Click **Authorize** (top right) and paste the raw API key — it is sent as',
        '   `Authorization: Bearer <apiKey>`.',
        '3. **POST /deposits** — mock a verified fiat deposit; note its `referenceId`.',
        '4. **POST /mint** — set an `Idempotency-Key` header, pass the deposit `referenceId`',
        '   and a partner `toAddress`. Poll **GET /mint/{id}** until `CONFIRMED`.',
        '5. **POST /transfers** / **POST /withdrawals** — settlement ops are keyed by the',
        '   on-chain `referenceId`.',
      ].join('\n'),
    },
    servers: [
      {
        url: 'http://localhost:3000/api/v1',
        description: 'Development server',
      },
    ],
    tags: [
      { name: 'Clients', description: 'Client onboarding and API-key issuance' },
      { name: 'Deposits', description: 'Fiat deposit verification (mocked bank webhook)' },
      { name: 'Mint', description: 'Issue on-chain settlement value against a verified deposit' },
      { name: 'Transfers', description: 'Move a settlement between approved partners' },
      { name: 'Withdrawals', description: 'Redeem a settlement to fiat and close it on-chain' },
      { name: 'Proposals', description: 'DAO proposals for mint/burn/transfer (v2 settlement contracts)' },
      { name: 'Wallets', description: 'Wallet whitelist: only approved addresses may hold settlement value' },
      { name: 'Documents', description: 'Proof documents (bank statements, receipts) attached to deposits and payouts' },
      { name: 'DAO', description: 'DAO verification: members review evidence and vote on deposits and withdrawals' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API_KEY',
          description: 'Provide your API key in the format: Bearer vg_live_...',
        },
      },
      parameters: {
        DaoToken: {
          name: 'X-DAO-Token',
          in: 'header',
          required: true,
          description: 'DAO member token from POST /dao/members (vg_dao_...).',
          schema: { type: 'string' },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description: 'Unique key (>= 10 chars) that makes the write operation safe to retry.',
          schema: { type: 'string', minLength: 10, example: 'idem-key-0001-abcdef' },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'referenceId is required' },
              },
            },
            request_id: { type: 'string', nullable: true },
          },
        },
        ClientRegisterRequest: {
          type: 'object',
          required: ['name', 'permissions'],
          properties: {
            name: { type: 'string', example: 'Acme Payments' },
            permissions: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ', 'DEPOSIT_WRITE'],
              },
              example: ['MINT', 'TRANSFER', 'WITHDRAW', 'WITHDRAW_STATUS', 'TRANSACTION_READ'],
            },
            blockchainAddress: {
              type: 'string',
              description: 'Optional partner wallet. Required (active) to call mint/transfer/withdraw.',
              example: '0x0133F71677B3de040CA09c63F285DE5EDD3912Be',
            },
          },
        },
        ClientRegisterResponse: {
          type: 'object',
          properties: {
            clientId: { type: 'string', example: 'a1b2c3d4-...' },
            name: { type: 'string', example: 'Acme Payments' },
            apiKey: {
              type: 'string',
              description: 'Raw API key — shown only once. Save it.',
              example: 'vg_live_9f8e7d...',
            },
            permissions: { type: 'array', items: { type: 'string' } },
            blockchainAddress: { type: 'string', nullable: true },
          },
        },
        DepositRequest: {
          type: 'object',
          required: ['amount', 'referenceId'],
          properties: {
            amount: { type: 'string', example: '1000.00' },
            currency: { type: 'string', default: 'USD', example: 'USD' },
            referenceId: {
              type: 'string',
              description: 'Unique deposit reference; reused as the on-chain settlement key when minting.',
              example: 'DEP-2026-0001',
            },
            proof: {
              type: 'object',
              description: 'Required when DAO verification is enabled: the evidence DAO members check.',
              required: ['bankReference'],
              properties: {
                bankReference: { type: 'string', example: 'UTR-ICIC-554201' },
                payerName: { type: 'string', example: 'Alice Sharma' },
                notes: { type: 'string', example: 'NEFT from ICICI a/c ending 4411' },
                documentHash: { type: 'string', description: 'Optional hash of the bank statement/receipt' },
              },
            },
          },
        },
        MintRequest: {
          type: 'object',
          required: ['amount', 'referenceId', 'toAddress'],
          properties: {
            amount: {
              type: 'string',
              description: 'Ignored server-side — the mint is tied to the verified deposit amount.',
              example: '1000.00',
            },
            referenceId: {
              type: 'string',
              description: 'The VERIFIED deposit referenceId to mint against.',
              example: 'DEP-2026-0001',
            },
            toAddress: {
              type: 'string',
              description: 'Partner wallet that receives the settlement (auto-registered on-chain).',
              example: '0x0133F71677B3de040CA09c63F285DE5EDD3912Be',
            },
            corridor: { type: 'string', example: 'US-MX', default: 'DEFAULT' },
          },
        },
        TransferRequest: {
          type: 'object',
          required: ['amount', 'fromAddress', 'toAddress', 'referenceId'],
          properties: {
            amount: { type: 'string', example: '1000.00' },
            fromAddress: {
              type: 'string',
              description: 'Sending partner wallet (must be owned by the calling client).',
              example: '0x0133F71677B3de040CA09c63F285DE5EDD3912Be',
            },
            toAddress: {
              type: 'string',
              description: 'Receiving partner wallet (must be an approved partner on-chain).',
              example: '0x218aCbE2Ee6fCe82D4586F2E634A56728b934F4c',
            },
            referenceId: {
              type: 'string',
              description: 'The MINTED settlement to transfer (whole-settlement move).',
              example: 'DEP-2026-0001',
            },
          },
        },
        WithdrawalRequest: {
          type: 'object',
          required: ['amount', 'bankDetails', 'fromAddress', 'referenceId'],
          properties: {
            amount: { type: 'string', example: '1000.00' },
            bankDetails: {
              type: 'object',
              example: { accountNumber: '000123456789', ifsc: 'HDFC0001234', name: 'Acme Payments' },
            },
            fromAddress: {
              type: 'string',
              description: 'Partner wallet being redeemed (must be owned by the calling client).',
              example: '0x0133F71677B3de040CA09c63F285DE5EDD3912Be',
            },
            referenceId: {
              type: 'string',
              description: 'The settlement to redeem/close on payout confirmation.',
              example: 'DEP-2026-0001',
            },
            windowMinutes: {
              type: 'integer',
              description: 'DAO mode: minutes allowed to pay out and get verified before funds are released (1-1440).',
              example: 15,
            },
          },
        },
        AcceptedTransaction: {
          type: 'object',
          properties: {
            transactionId: { type: 'string', example: 'f1e2d3c4-...' },
            status: { type: 'string', example: 'PENDING' },
            message: { type: 'string' },
          },
        },
        TransactionStatus: {
          type: 'object',
          properties: {
            transactionId: { type: 'string' },
            status: { type: 'string', enum: ['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED'], example: 'CONFIRMED' },
            blockchainTxHash: { type: 'string', nullable: true },
            failureReason: { type: 'string', nullable: true },
          },
        },
      },
      responses: {
        ValidationError: {
          description: 'Invalid request (validation / bad state)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        Unauthorized: {
          description: 'Missing or invalid API key',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        Forbidden: {
          description: 'Insufficient scope or no active blockchain account',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        NotFound: {
          description: 'Resource not found',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
        Conflict: {
          description: 'Duplicate or conflicting state',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes.ts', './src/modules/**/*.ts'],
};

export const swaggerSpec = swaggerJSDoc(options);
