import { webhookWorker } from '../../src/workers/webhook.worker';
import { prismaMock } from '../setup';

const runProcessor = (job: any) => (webhookWorker as any).__processor(job);
const runFailedHandler = (job: any, err: any) => (webhookWorker as any).__handlers['failed'][0](job, err);

describe('webhook.worker processWebhook', () => {
  const job = {
    data: {
      deliveryId: 'delivery-1',
      clientId: 'client-1',
      url: 'https://api.example.com/webhooks/vg',
      event: 'mint.completed',
      payload: { transactionId: 'tx-1' },
    },
  };

  it('increments attempts and marks the delivery DELIVERED on success', async () => {
    prismaMock.webhookDelivery.update.mockResolvedValue({} as any);

    await runProcessor(job);

    expect(prismaMock.webhookDelivery.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'delivery-1' },
      data: { attempts: { increment: 1 } },
    });
    expect(prismaMock.webhookDelivery.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'delivery-1' },
      data: { status: 'DELIVERED' },
    });
  });

  it('rethrows so BullMQ can retry when the delivery update fails', async () => {
    prismaMock.webhookDelivery.update
      .mockResolvedValueOnce({} as any) // attempts increment succeeds
      .mockRejectedValueOnce(new Error('DB down')); // DELIVERED update fails

    await expect(runProcessor(job)).rejects.toThrow('DB down');
  });
});

describe("webhook.worker 'failed' event handler", () => {
  it('does nothing when no job is provided', async () => {
    await expect(runFailedHandler(undefined, new Error('x'))).resolves.toBeUndefined();
    expect(prismaMock.webhookDelivery.update).not.toHaveBeenCalled();
  });

  it('marks the delivery FAILED once attemptsMade reaches the configured attempts limit', async () => {
    prismaMock.webhookDelivery.update.mockResolvedValue({} as any);
    const job = { id: 'job-1', attemptsMade: 5, opts: { attempts: 5 }, data: { deliveryId: 'delivery-1' } };

    await runFailedHandler(job, new Error('gave up'));

    expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: { status: 'FAILED' },
    });
  });

  it('leaves the delivery untouched while attempts remain', async () => {
    const job = { id: 'job-1', attemptsMade: 2, opts: { attempts: 5 }, data: { deliveryId: 'delivery-1' } };

    await runFailedHandler(job, new Error('will retry'));

    expect(prismaMock.webhookDelivery.update).not.toHaveBeenCalled();
  });

  it('defaults the attempts limit to 3 when opts.attempts is not set', async () => {
    prismaMock.webhookDelivery.update.mockResolvedValue({} as any);
    const job = { id: 'job-1', attemptsMade: 3, opts: {}, data: { deliveryId: 'delivery-1' } };

    await runFailedHandler(job, new Error('gave up'));

    expect(prismaMock.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-1' },
      data: { status: 'FAILED' },
    });
  });
});
