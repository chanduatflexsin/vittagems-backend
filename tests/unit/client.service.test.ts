import { ClientService } from '../../src/modules/clients/client.service';
import { prismaMock } from '../setup';

describe('ClientService.generateApiKey', () => {
  it('returns a raw key with the given prefix and a deterministic HMAC hash', () => {
    const { rawKey, keyHash } = ClientService.generateApiKey();
    expect(rawKey.startsWith('vg_live_')).toBe(true);
    expect(keyHash).toHaveLength(64); // sha256 hex digest
  });

  it('honors a custom prefix', () => {
    const { rawKey } = ClientService.generateApiKey('vg_test_');
    expect(rawKey.startsWith('vg_test_')).toBe(true);
  });

  it('produces a different raw key (and hash) on every call', () => {
    const first = ClientService.generateApiKey();
    const second = ClientService.generateApiKey();
    expect(first.rawKey).not.toBe(second.rawKey);
    expect(first.keyHash).not.toBe(second.keyHash);
  });
});

describe('ClientService.registerClient', () => {
  it('creates a client with a hashed key, requested permissions, and optional blockchain account', async () => {
    prismaMock.client.create.mockResolvedValue({ id: 'client-1', name: 'Acme' } as any);

    const result = await ClientService.registerClient('Acme', ['MINT', 'TRANSFER'], '0xabc');

    expect(result.clientId).toBe('client-1');
    expect(result.name).toBe('Acme');
    expect(result.apiKey).toMatch(/^vg_live_/);
    expect(result.permissions).toEqual(['MINT', 'TRANSFER']);
    expect(result.blockchainAddress).toBe('0xabc');

    const createArgs = prismaMock.client.create.mock.calls[0][0] as any;
    expect(createArgs.data.name).toBe('Acme');
    expect(createArgs.data.ApiKeys.create.Permissions.create).toEqual([
      { scope: 'MINT' },
      { scope: 'TRANSFER' },
    ]);
    expect(createArgs.data.BlockchainAccounts.create).toEqual({ address: '0xabc' });
  });

  it('omits BlockchainAccounts creation when no address is provided', async () => {
    prismaMock.client.create.mockResolvedValue({ id: 'client-2', name: 'NoChain' } as any);

    await ClientService.registerClient('NoChain', ['MINT']);

    const createArgs = prismaMock.client.create.mock.calls[0][0] as any;
    expect(createArgs.data.BlockchainAccounts).toBeUndefined();
  });

  it('never returns the key hash, only the raw key', async () => {
    prismaMock.client.create.mockResolvedValue({ id: 'client-3', name: 'Secure' } as any);

    const result = await ClientService.registerClient('Secure', []);

    expect(result).not.toHaveProperty('keyHash');
  });
});

describe('ClientService.getClientDetails', () => {
  it('returns the client when found', async () => {
    const client = { id: 'client-1', name: 'Acme', BlockchainAccounts: [], ApiKeys: [] };
    prismaMock.client.findUnique.mockResolvedValue(client as any);

    const result = await ClientService.getClientDetails('client-1');
    expect(result).toEqual(client);
  });

  it('throws NotFoundError when the client does not exist', async () => {
    prismaMock.client.findUnique.mockResolvedValue(null);

    await expect(ClientService.getClientDetails('missing')).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});
