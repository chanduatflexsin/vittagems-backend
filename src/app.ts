import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { errorHandler } from './middleware/errorHandler';
import { env } from './config/env';

const app = express();

// Security Middlewares
app.use(helmet());
app.use(cors());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: env.RATE_LIMIT_MAX, // per-IP requests per window (RATE_LIMIT_MAX; raise for dev/demo polling)
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Body Parser
app.use(express.json());

// Swagger Docs
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Basic healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

import routes from './routes';

// Routes
app.use('/api/v1', routes);

// Global Error Handler
app.use(errorHandler);

export default app;
