import request from 'supertest';
import app from '../src/app';
import { env } from '../src/config/env';

describe('API Endpoints', () => {
  it('GET /health should return 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/v1/client should return 401 without API Key', async () => {
    const res = await request(app).get('/api/v1/client');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('requires the dedicated KYC admin key and supports partner attestations', async () => {
    const account = '0x6c56fdc4845469a13098a68662faa41837e75056';
    const path = `/api/v1/admin/partners/${account}/kyc`;
    const unauthorized = await request(app).get(path);
    expect(unauthorized.status).toBe(401);

    const adminKey = process.env.KYC_ADMIN_API_KEY as string;
    const invalidKey = await request(app)
      .get(path)
      .set('Authorization', 'Bearer not-the-admin-key');
    expect(invalidKey.status).toBe(401);

    const invalid = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ validUntil: Math.floor(Date.now() / 1000) + 3600, claimsHash: '0x' + '0'.repeat(64) });
    expect(invalid.status).toBe(400);

    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    const verified = await request(app)
      .post(path)
      .set('Authorization', `Bearer ${adminKey}`)
      .send({ validUntil, claimsHash: `0x${'1'.repeat(64)}` });
    expect(verified.status).toBe(200);
    expect(verified.body.data.txHash).toMatch(/^0xmock_kyc_set_/);

    const status = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${adminKey}`);
    expect(status.status).toBe(200);
    expect(status.body.data.isVerified).toBe(true);

    const revoked = await request(app)
      .delete(path)
      .set('Authorization', `Bearer ${adminKey}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.txHash).toMatch(/^0xmock_kyc_revoke_/);
  });

  it('fails closed when the KYC admin key is not configured', async () => {
    const configuredKey = env.KYC_ADMIN_API_KEY;
    env.KYC_ADMIN_API_KEY = undefined;
    try {
      const res = await request(app)
        .get('/api/v1/admin/partners/0x6c56fdc4845469a13098a68662faa41837e75056/kyc');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('KYC_ADMIN_NOT_CONFIGURED');
    } finally {
      env.KYC_ADMIN_API_KEY = configuredKey;
    }
  });
});
