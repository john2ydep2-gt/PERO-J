const express = require('express');

const CACHE_TTL_MS = 60 * 1000;

/**
 * Creates the stats router exposing aggregate counts.
 *
 * @param {object} db database client exposing getStats()
 * @returns {import('express').Router}
 */
function createStatsRouter(db) {
  const router = express.Router();

  let cache = null;
  let cacheExpiresAt = 0;

  /**
   * @openapi
   * /stats:
   *   get:
   *     summary: Get aggregate stats
   *     description: Returns aggregate counts (e.g. markets, trades, volume) with a short-lived server-side cache.
   *     tags:
   *       - Stats
   *     responses:
   *       200:
   *         description: Aggregate counts
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               additionalProperties: true
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   */
  router.get('/stats', async (req, res, next) => {
    try {
      const now = Date.now();
      if (!cache || now >= cacheExpiresAt) {
        cache = await db.getStats();
        cacheExpiresAt = now + CACHE_TTL_MS;
      }

      res.json(cache);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createStatsRouter;
module.exports.createStatsRouter = createStatsRouter;
module.exports.CACHE_TTL_MS = CACHE_TTL_MS;