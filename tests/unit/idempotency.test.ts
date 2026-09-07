import { Request, Response } from 'express';
import { requireIdempotency } from '../../src/middleware/idempotency';
import { prismaMock } from '../setup';

function createReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
  } as unknown as Request;
}

function createMockResponse() {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

describe('requireIdempotency', () => {
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
  });

  it('rejects when the Idempotency-Key header is missing', async () => {
    const req = createReq();
    const res = createMockResponse();

    await requireIdempotency(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/Idempotency-Key header is required/);
  });

  it('rejects when the Idempotency-Key is shorter than 10 characters', async () => {
    const req = createReq({ 'idempotency-key': 'short' });
    const res = createMockResponse();

    await requireIdempotency(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/at least 10 characters/);
  });

  it('returns the existing transaction with 200 when the key was already used (duplicate request)', async () => {
    const existingTx = { id: 'tx-1', status: 'CONFIRMED', idempotencyKey: 'already-used-key' };
    prismaMock.transaction.findUnique.mockResolvedValue(existingTx as any);
    const req = createReq({ 'idempotency-key': 'already-used-key' });
    const res = createMockResponse();

    await requireIdempotency(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Duplicate request detected. Returning existing transaction.',
      data: existingTx,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the key to the request and calls next() when it is unused', async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(null);
    const req = createReq({ 'idempotency-key': 'brand-new-key-123' });
    const res = createMockResponse();

    await requireIdempotency(req, res, next);

    expect((req as any).idempotencyKey).toBe('brand-new-key-123');
    expect(next).toHaveBeenCalledWith();
  });

  it('forwards unexpected DB errors to next()', async () => {
    prismaMock.transaction.findUnique.mockRejectedValue(new Error('DB down'));
    const req = createReq({ 'idempotency-key': 'brand-new-key-123' });
    const res = createMockResponse();

    await requireIdempotency(req, res, next);

    expect(next.mock.calls[0][0].message).toBe('DB down');
  });
});
