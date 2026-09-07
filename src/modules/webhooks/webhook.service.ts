import { webhookQueue } from '../../workers/webhook.worker';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class WebhookService {
  /**
   * Dispatches a webhook to the client (if they have a URL configured).
   * Note: We are simulating that a client has a webhook URL.
   */
  static async dispatch(clientId: string, event: string, payload: any) {
    // Create DB record
    const delivery = await prisma.webhookDelivery.create({
      data: {
        clientId,
        event,
        payload,
        status: 'PENDING'
      }
    });

    // Enqueue job
    await webhookQueue.add(
      'dispatch', 
      {
        deliveryId: delivery.id,
        clientId,
        url: 'https://api.example.com/webhooks/vg', // Mocked URL
        event,
        payload
      },
      {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        }
      }
    );
  }
}
