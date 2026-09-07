import { WebhookService } from '../../src/modules/webhooks/webhook.service';
import { webhookQueue } from '../../src/workers/webhook.worker';
import { prismaMock } from '../setup';

describe('WebhookService.dispatch', () => {
  it('creates a PENDING WebhookDelivery record and enqueues a retryable delivery job', async () => {
    prismaMock.webhookDelivery.create.mockResolvedValue({ id: 'delivery-1' } as any);

    await WebhookService.dispatch('client-1', 'mint.completed', { transactionId: 'tx-1' });

    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledWith({
      data: {
        clientId: 'client-1',
        event: 'mint.completed',
        payload: { transactionId: 'tx-1' },
        status: 'PENDING',
      },
    });

    expect(webhookQueue.add).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        deliveryId: 'delivery-1',
        clientId: 'client-1',
        event: 'mint.completed',
        payload: { transactionId: 'tx-1' },
      }),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      })
    );
  });
});
