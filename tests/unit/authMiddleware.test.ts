import { Request, Response } from 'express';
import crypto from 'crypto';
import {
  authenticateApiKey,
  requirePermissions,
  requireBlockchainAccess,
} from '../../src/middleware/authMiddleware';
import { prismaMock } from '../setup';
import { env } from '../../src/config/env';

function createReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
    path: '/api/v1/client',
    method: 'GET',
  } as unknown as Request;
}

function hashKey(rawKey: string) {
  return crypto.createHmac('sha256', env.API_KEY_SECRET).update(rawKey).digest('hex');
}

describe('authenticateApiKey', () => {
  const res = {} as Response;
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
  });

  it('rejects requests with no Authorization header', async () => {
    const req = createReq();
    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with a malformed Authorization header (no Bearer prefix)', async () => {
    const req = createReq({ authorization: 'Basic abc123' });
    await authenticateApiKey(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
  });

  it('rejects when the hashed key has no matching ApiKey record', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue(null);
    const req = createReq({ authorization: 'Bearer vg_live_unknown' });

    await authenticateApiKey(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/Invalid or revoked/);
  });

  it('rejects an inactive (revoked) API key', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      isActive: false,
      expiresAt: null,
      client: { id: 'client-1', isActive: true },
      Permissions: [],
    } as any);
    const req = createReq({ authorization: 'Bearer vg_live_revoked' });

    await authenticateApiKey(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
  });

  it('rejects an expired API key', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      isActive: true,
      expiresAt: new Date(Date.now() - 1000 * 60),
      client: { id: 'client-1', isActive: true },
      Permissions: [],
    } as any);
    const req = createReq({ authorization: 'Bearer vg_live_expired' });

    await authenticateApiKey(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(401);
    expect(err.message).toMatch(/expired/);
  });

  it('rejects when the owning client is suspended', async () => {
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      isActive: true,
      expiresAt: null,
      client: { id: 'client-1', isActive: false },
      Permissions: [],
    } as any);
    const req = createReq({ authorization: 'Bearer vg_live_suspendedclient' });

    await authenticateApiKey(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/suspended/);
  });

  it('accepts a valid, active, unexpired key and attaches client/apiKey/permissions to req', async () => {
    const client = { id: 'client-1', isActive: true, name: 'Acme' };
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      isActive: true,
      expiresAt: null,
      client,
      Permissions: [{ scope: 'MINT' }, { scope: 'TRANSFER' }],
    } as any);
    const req = createReq({ authorization: 'Bearer vg_live_validkey' });

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as any).client).toEqual(client);
    expect((req as any).permissions).toEqual(['MINT', 'TRANSFER']);
    expect(prismaMock.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: hashKey('vg_live_validkey') },
      include: { client: true, Permissions: true },
    });
  });

  it('forwards unexpected DB errors to next() instead of throwing', async () => {
    prismaMock.apiKey.findUnique.mockRejectedValue(new Error('DB down'));
    const req = createReq({ authorization: 'Bearer vg_live_whatever' });

    await authenticateApiKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe('DB down');
  });
});

describe('requirePermissions', () => {
  const res = {} as Response;
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
  });

  it('calls next() when all required scopes are present', () => {
    const req = { permissions: ['MINT', 'TRANSFER'] } as unknown as Request;
    requirePermissions(['MINT'])(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects with 403 when a required scope is missing', () => {
    const req = { permissions: ['TRANSFER'] } as unknown as Request;
    requirePermissions(['MINT'])(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/MINT/);
  });

  it('rejects with 403 when permissions were never loaded onto the request', () => {
    const req = {} as unknown as Request;
    requirePermissions(['MINT'])(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/No permissions loaded/);
  });

  it('requires every scope, not just one, when multiple are given', () => {
    const req = { permissions: ['MINT'] } as unknown as Request;
    requirePermissions(['MINT', 'TRANSFER'])(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });
});

describe('requireBlockchainAccess', () => {
  const res = {} as Response;
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
  });

  it('attaches the active blockchain account and calls next() when found', async () => {
    const account = { id: 'acc-1', clientId: 'client-1', address: '0xabc', isActive: true };
    prismaMock.blockchainAccount.findFirst.mockResolvedValue(account as any);
    const req = { client: { id: 'client-1' } } as unknown as Request;

    await requireBlockchainAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as any).blockchainAccount).toEqual(account);
  });

  it('rejects with 403 when the client has no active blockchain account', async () => {
    prismaMock.blockchainAccount.findFirst.mockResolvedValue(null);
    const req = { client: { id: 'client-1' } } as unknown as Request;

    await requireBlockchainAccess(req, res, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('BLOCKCHAIN_ACCESS_DENIED');
  });
});
