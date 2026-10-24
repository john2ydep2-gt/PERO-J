const express = require('express');
const router = express.Router();
const db = require('../db');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * @openapi
 * /api/contracts/{id}/events:
 *   get:
 *     summary: Get paginated event history for a contract
 *     description: Returns a paginated list of events emitted by a single contract, optionally filtered by function name.
 *     tags:
 *       - Contracts
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The contract identifier.
 *       - in: query
 *         name: fn
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter events by function name.
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number (1-based).
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of events per page.
 *     responses:
 *       200:
 *         description: Paginated list of contract events.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *       404:
 *         description: Contract not found.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Contract not found
 *       500:
 *         description: Failed to fetch contract events.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to fetch contract events
 */
// GET /api/contracts/:id/events?fn=&page=
// Paginated event history for a single contract, optionally filtered by function name.
router.get('/:id/events', async (req, res) => {
  const { id } = req.params;
  const { fn } = req.query;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
  );
  const offset = (page - 1) * limit;

  try {
    const contract = await db.getContractById(id);
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    const { events, total } = await db.getEventsByContract({
      contractId: id,
      fn: fn || null,
      limit,
      offset,
    });

    return res.json({ events, total, page, limit });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch contract events' });
  }
});

module.exports = router;