import { Queue, Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import crypto from 'crypto';

const prisma = new PrismaClient();
const connection = { url: env.REDIS_URL };

export const webhookQueue = new Queue('webhook-deliveries', { connection });

interface WebhookJobData {
  deliveryId: string;
  clientId: string;
  url: string;
  event: string;
  payload: any;
}

const processWebhook = async (job: Job<WebhookJobData>) => {
  const { deliveryId, url, event, payload } = job.data;
  
  logger.info(`Attempting delivery of webhook ${deliveryId} to ${url}`);

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { attempts: { increment: 1 } }
  });

  try {
    // Generate HMAC signature for security
    const timestamp = Date.now().toString();
    const signaturePayload = `${timestamp}.${JSON.stringify(payload)}`;
    const signature = crypto
      .createHmac('sha256', env.WEBHOOK_SECRET)
      .update(signaturePayload)
      .digest('hex');

    // MOCK: Actually dispatch via fetch
    // const response = await fetch(url, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json',
    //     'x-vg-signature': signature,
    //     'x-vg-timestamp': timestamp
    //   },
    //   body: JSON.stringify(payload)
    // });
    
    // if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    
    // Simulating successful delivery
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'DELIVERED' }
    });
    
    logger.info(`Webhook ${deliveryId} delivered successfully`);
    
  } catch (error: any) {
    logger.error(`Webhook ${deliveryId} failed: ${error.message}`);
    throw error; // Triggers BullMQ retry
  }
};

export const webhookWorker = new Worker('webhook-deliveries', processWebhook, { 
  connection,
  concurrency: 10,
  limiter: {
    max: 100,
    duration: 1000,
  }
});

webhookWorker.on('failed', async (job, err) => {
  if (!job) return;
  logger.warn(`Webhook job ${job.id} failed attempt. ${err.message}`);
  
  // If it exceeded max attempts, mark as FAILED
  if (job.attemptsMade >= (job.opts.attempts || 3)) {
    await prisma.webhookDelivery.update({
      where: { id: job.data.deliveryId },
      data: { status: 'FAILED' }
    });
  }
});
