import request from 'supertest';
import app from '../src/app';

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
});
