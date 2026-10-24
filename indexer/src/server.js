const express = require('express');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
const db = require('./db');

const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://horizon-testnet.stellar.org https://soroban-testnet.stellar.org https://*.stellar.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;"
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.removeHeader('X-Powered-By');
  next();
});

// CORS allowlist
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  const allowed = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
    'https://drips.network',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(express.json());

const STATS_CACHE_TTL_MS = 60 * 1000;
let statsCache = null;
let statsCacheExpiresAt = 0;

/**
 * @openapi
 * /api/stats:
 *   get:
 *     summary: Get indexer statistics
 *     description: Returns aggregated indexer statistics. Responses are cached for 60 seconds.
 *     tags:
 *       - Stats
 *     responses:
 *       200:
 *         description: Indexer statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       500:
 *         description: Failed to load stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to load stats
 */
app.get('/api/stats', async (req, res) => {
  try {
    const now = Date.now();
    if (statsCache && now < statsCacheExpiresAt) {
      return res.json(statsCache);
    }

    const stats = await db.getStats();
    statsCache = stats;
    statsCacheExpiresAt = now + STATS_CACHE_TTL_MS;
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load stats' });
  }
});

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Prediction Market Indexer API',
      version: '1.0.0',
      description: 'Machine-readable API documentation for the prediction market indexer.',
    },
    servers: [{ url: '/' }],
  },
  apis: [
    './src/**/*.js',
    './src/**/*.yaml',
    './src/**/*.yml',
  ],
});

const docsEnabled = ['development', 'staging'].includes(process.env.NODE_ENV);

if (docsEnabled) {
  app.get('/docs/openapi.json', (req, res) => {
    res.json(swaggerSpec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

module.exports = app;