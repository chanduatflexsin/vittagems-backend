import request from 'supertest';
import app from '../../src/app';
import { prismaMock } from '../setup';
import { transactionQueue } from '../../src/workers/transaction.worker';

const RAW_API_KEY = 'vg_live_testkey';
const AUTH_HEADER = `Bearer ${RAW_API_KEY}`;

function mockAuthenticatedClient(overrides: {
  clientId?: string;
  clientActive?: boolean;
  keyActive?: boolean;
  expiresAt?: Date | null;
  permissions?: string[];
} = {}) {
  const {
    clientId = 'client-1',
    clientActive = true,
    keyActive = true,
    expiresAt = null,
    permissions = [],
  } = overrides;

  prismaMock.apiKey.findUnique.mockResolvedValue({
    id: 'key-1',
    isActive: keyActive,
    expiresAt,
    client: { id: clientId, isActive: clientActive, name: 'Test Client' },
    Permissions: permissions.map((scope) => ({ scope })),
  } as any);
}

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('Unknown routes', () => {
  it('returns 404 for a route that does not exist', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/clients/register', () => {
  it('registers a new client and returns a raw API key exactly once', async () => {
    prismaMock.client.create.mockResolvedValue({ id: 'client-new', name: 'New Co' } as any);
    prismaMock.whitelistedWallet.findUnique.mockResolvedValue(null);
    prismaMock.whitelistedWallet.create.mockResolvedValue({
      id: 'w1', address: '0x0133f71677b3de040ca09c63f285de5edd3912be', label: 'New Co settlement wallet',
      status: 'PENDING', reason: null, decidedBy: null, decidedAt: null, onChainRegisteredAt: null, createdAt: new Date(),
    } as any);

    const res = await request(app)
      .post('/api/v1/clients/register')
      .send({ name: 'New Co', permissions: ['MINT'], blockchainAddress: '0x0133F71677B3de040CA09c63F285DE5EDD3912Be' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.clientId).toBe('client-new');
    expect(res.body.data.apiKey).toMatch(/^vg_live_/);
    expect(res.body.data.permissions).toEqual(['MINT']);
  });

  it('propagates unexpected DB errors as a 500 via the error handler', async () => {
    prismaMock.client.create.mockRejectedValue(new Error('DB down'));

    const res = await request(app).post('/api/v1/clients/register').send({ name: 'Bad Co', permissions: [] });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/client', () => {
  it('rejects without an Authorization header', async () => {
    const res = await request(app).get('/api/v1/client');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects an unknown API key', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/client').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(401);
  });

  it('rejects when the client account is suspended', async () => {
    mockAuthenticatedClient({ clientActive: false });

    const res = await request(app).get('/api/v1/client').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('propagates NotFoundError from the service when the client record is gone', async () => {
    mockAuthenticatedClient({ clientId: 'client-1' });
    prismaMock.client.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/client').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('returns client details for a valid key', async () => {
    mockAuthenticatedClient({ clientId: 'client-1' });
    prismaMock.client.findUnique.mockResolvedValue({
      id: 'client-1',
      name: 'Test Client',
      BlockchainAccounts: [],
      ApiKeys: [],
    } as any);

    const res = await request(app).get('/api/v1/client').set('Authorization', AUTH_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('client-1');
  });
});

describe('POST /api/v1/deposits', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/deposits').send({ amount: '100', referenceId: 'ref-1' });
    expect(res.status).toBe(401);
  });

  it('registers a mock deposit as VERIFIED', async () => {
    mockAuthenticatedClient();
    prismaMock.deposit.findUnique.mockResolvedValue(null);
    prismaMock.deposit.create.mockResolvedValue({ id: 'dep-1', referenceId: 'ref-1', status: 'VERIFIED' } as any);

    const res = await request(app)
      .post('/api/v1/deposits')
      .set('Authorization', AUTH_HEADER)
      .send({ amount: '100', currency: 'USD', referenceId: 'ref-1' });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('VERIFIED');
  });

  it('returns 409 for a duplicate referenceId', async () => {
    mockAuthenticatedClient();
    prismaMock.deposit.findUnique.mockResolvedValue({ id: 'dep-1', referenceId: 'ref-1' } as any);

    const res = await request(app)
      .post('/api/v1/deposits')
      .set('Authorization', AUTH_HEADER)
      .send({ amount: '100', referenceId: 'ref-1' });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/v1/mint', () => {
  const validBody = { amount: '50', referenceId: 'ref-1', toAddress: '0xdead' };

  it('requires the MINT scope', async () => {
    mockAuthenticatedClient({ permissions: [] });

    const res = await request(app)
      .post('/api/v1/mint')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send(validBody);

    expect(res.status).toBe(403);
  });

  it('requires an active blockchain account even with MINT scope', async () => {
    mockAuthenticatedClient({ permissions: ['MINT'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/mint')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BLOCKCHAIN_ACCESS_DENIED');
  });

  it('requires an Idempotency-Key header', async () => {
    mockAuthenticatedClient({ permissions: ['MINT'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);

    const res = await request(app).post('/api/v1/mint').set('Authorization', AUTH_HEADER).send(validBody);

    expect(res.status).toBe(400);
  });

  it('404s when the referenced deposit does not exist', async () => {
    mockAuthenticatedClient({ permissions: ['MINT'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);
    prismaMock.transaction.findUnique.mockResolvedValue(null); // idempotency check: unused key
    prismaMock.deposit.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/mint')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send(validBody);

    expect(res.status).toBe(404);
  });

  it('accepts a valid mint request and queues the blockchain job (202)', async () => {
    mockAuthenticatedClient({ clientId: 'client-1', permissions: ['MINT'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);
    prismaMock.transaction.findUnique.mockResolvedValue(null); // idempotency: key unused
    prismaMock.deposit.findUnique.mockResolvedValue({ id: 'dep-1', status: 'VERIFIED', amount: '50' } as any);
    prismaMock.transaction.findFirst.mockResolvedValue(null); // no existing mint for this deposit
    prismaMock.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'PENDING' } as any);

    const res = await request(app)
      .post('/api/v1/mint')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send(validBody);

    expect(res.status).toBe(202);
    expect(res.body.data.transactionId).toBe('tx-1');
    expect(transactionQueue.add).toHaveBeenCalledWith('process-mint', {
      transactionId: 'tx-1',
      toAddress: '0xdead',
      amount: '50',
    });
  });

  it('short-circuits with the cached transaction on a repeated Idempotency-Key', async () => {
    mockAuthenticatedClient({ permissions: ['MINT'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1' } as any);
    prismaMock.transaction.findUnique.mockResolvedValue({ id: 'tx-existing', status: 'CONFIRMED' } as any);

    const res = await request(app)
      .post('/api/v1/mint')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/Duplicate request detected/);
    expect(prismaMock.deposit.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/mint/:id', () => {
  it('requires the TRANSACTION_READ scope', async () => {
    mockAuthenticatedClient({ permissions: [] });

    const res = await request(app).get('/api/v1/mint/tx-1').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the mint transaction does not exist', async () => {
    mockAuthenticatedClient({ permissions: ['TRANSACTION_READ'] });
    prismaMock.transaction.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/mint/missing-tx').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('returns the mint status when owned by the requesting client', async () => {
    mockAuthenticatedClient({ clientId: 'client-1', permissions: ['TRANSACTION_READ'] });
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      clientId: 'client-1',
      status: 'CONFIRMED',
      blockchainTxHash: '0xhash',
      failureReason: null,
    } as any);

    const res = await request(app).get('/api/v1/mint/tx-1').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CONFIRMED');
  });
});

describe('POST /api/v1/transfers', () => {
  it('requires the TRANSFER scope', async () => {
    mockAuthenticatedClient({ permissions: [] });

    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ amount: '10', fromAddress: '0xfrom', toAddress: '0xto' });

    expect(res.status).toBe(403);
  });

  it('rejects a fromAddress the client does not own', async () => {
    mockAuthenticatedClient({ permissions: ['TRANSFER'] });
    prismaMock.blockchainAccount.findFirst
      .mockResolvedValueOnce({ id: 'acc-1' } as any) // requireBlockchainAccess: has *some* account
      .mockResolvedValueOnce(null); // TransferService: doesn't own this specific fromAddress

    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ amount: '10', fromAddress: '0xnotmine', toAddress: '0xto', referenceId: 'VG-REF-1' });

    expect(res.status).toBe(403);
  });

  it('accepts a valid transfer request (202)', async () => {
    mockAuthenticatedClient({ permissions: ['TRANSFER'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1', address: '0xfrom' } as any);
    prismaMock.transaction.findUnique.mockResolvedValue(null);
    prismaMock.transaction.create.mockResolvedValue({ id: 'tx-1', status: 'PENDING' } as any);

    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ amount: '10', fromAddress: '0xfrom', toAddress: '0xto', referenceId: 'VG-REF-1' });

    expect(res.status).toBe(202);
    expect(res.body.data.transactionId).toBe('tx-1');
  });
});

describe('GET /api/v1/transfers/:id', () => {
  it('returns 404 when the transfer transaction does not exist', async () => {
    mockAuthenticatedClient({ permissions: ['TRANSACTION_READ'] });
    prismaMock.transaction.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/transfers/missing-tx').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('returns the transfer status when owned by the requesting client', async () => {
    mockAuthenticatedClient({ clientId: 'client-1', permissions: ['TRANSACTION_READ'] });
    prismaMock.transaction.findUnique.mockResolvedValue({
      id: 'tx-1',
      clientId: 'client-1',
      type: 'TRANSFER',
      status: 'SUBMITTED',
      blockchainTxHash: null,
      failureReason: null,
    } as any);

    const res = await request(app).get('/api/v1/transfers/tx-1').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUBMITTED');
  });
});

describe('POST /api/v1/withdrawals', () => {
  it('requires the WITHDRAW scope', async () => {
    mockAuthenticatedClient({ permissions: [] });

    const res = await request(app)
      .post('/api/v1/withdrawals')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ amount: '20', bankDetails: {}, fromAddress: '0xfrom' });

    expect(res.status).toBe(403);
  });

  it('returns 403 (via the controller, not just the middleware) when the service rejects the specific fromAddress', async () => {
    mockAuthenticatedClient({ permissions: ['WITHDRAW'] });
    // requireBlockchainAccess (middleware) sees *some* active account and lets the request through,
    // but WithdrawalService's stricter address-scoped ownership check rejects it.
    prismaMock.blockchainAccount.findFirst
      .mockResolvedValueOnce({ id: 'acc-1' } as any)
      .mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/v1/withdrawals')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ amount: '20', bankDetails: {}, fromAddress: '0xnotmine', referenceId: 'VG-REF-1' });

    expect(res.status).toBe(403);
  });

  it('creates a withdrawal request (202) when authorized', async () => {
    mockAuthenticatedClient({ permissions: ['WITHDRAW'] });
    prismaMock.blockchainAccount.findFirst.mockResolvedValue({ id: 'acc-1', address: '0xfrom' } as any);
    prismaMock.transaction.findUnique.mockResolvedValue(null);
    prismaMock.withdrawal.findUnique.mockResolvedValue(null);
    prismaMock.withdrawal.create.mockResolvedValue({ id: 'wd-1', status: 'REQUESTED' } as any);
    prismaMock.transaction.create.mockResolvedValue({ id: 'burn-tx-1' } as any);

    const res = await request(app)
      .post('/api/v1/withdrawals')
      .set('Authorization', AUTH_HEADER)
      .set('Idempotency-Key', 'idem-key-12345')
      .send({ amount: '20', bankDetails: { accountNumber: '123' }, fromAddress: '0xfrom', referenceId: 'VG-REF-1' });

    expect(res.status).toBe(202);
    expect(res.body.data.withdrawalId).toBe('wd-1');
    expect(res.body.data.status).toBe('REQUESTED');
  });
});

describe('POST /api/v1/withdrawals/:id/approve', () => {
  it('confirms payout on a REQUESTED withdrawal and queues the burn (no auth required, per route config)', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      status: 'REQUESTED',
      Transactions: [{ id: 'burn-tx-1', type: 'BURN', status: 'PENDING', amount: '20', referenceId: 'VG-REF-1' }],
    } as any);

    const res = await request(app).post('/api/v1/withdrawals/wd-1/approve');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('BURN_PENDING');
    expect(transactionQueue.add).toHaveBeenCalledWith('process-burn', {
      transactionId: 'burn-tx-1',
      amount: '20',
      referenceId: 'VG-REF-1',
    });
  });

  it('returns 409 when the withdrawal is not in REQUESTED status', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue({ id: 'wd-1', status: 'SETTLED', Transactions: [] } as any);

    const res = await request(app).post('/api/v1/withdrawals/wd-1/approve');
    expect(res.status).toBe(409);
  });

  it('returns 404 when the withdrawal does not exist', async () => {
    prismaMock.withdrawal.findUnique.mockResolvedValue(null);

    const res = await request(app).post('/api/v1/withdrawals/missing-wd/approve');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/withdrawals/:id', () => {
  it('requires the WITHDRAW_STATUS scope', async () => {
    mockAuthenticatedClient({ permissions: [] });

    const res = await request(app).get('/api/v1/withdrawals/wd-1').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the withdrawal does not exist', async () => {
    mockAuthenticatedClient({ permissions: ['WITHDRAW_STATUS'] });
    prismaMock.withdrawal.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/v1/withdrawals/missing-wd').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  it('returns withdrawal + burn status for the owning client', async () => {
    mockAuthenticatedClient({ clientId: 'client-1', permissions: ['WITHDRAW_STATUS'] });
    prismaMock.withdrawal.findUnique.mockResolvedValue({
      id: 'wd-1',
      clientId: 'client-1',
      status: 'APPROVED',
      Transactions: [{ type: 'BURN', status: 'CONFIRMED', blockchainTxHash: '0xhash' }],
    } as any);

    const res = await request(app).get('/api/v1/withdrawals/wd-1').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.data.burnTransactionStatus).toBe('CONFIRMED');
  });
});
