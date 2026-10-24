import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

const SPECIAL_CHARS = /[^\p{L}\p{N}\s]/u;

/**
 * @openapi
 * /api/events:
 *   get:
 *     summary: Search and list contract events
 *     description: >
 *       Returns up to 100 contract events ordered by ledger (descending).
 *       Supports filtering by contract ID, function name, and a free-text
 *       search term applied against the event description. Terms containing
 *       special characters use a case-insensitive substring match (ILIKE),
 *       while plain terms use full-text search.
 *     tags:
 *       - Events
 *     parameters:
 *       - in: query
 *         name: q
 *         required: false
 *         schema:
 *           type: string
 *         description: >
 *           Free-text search term matched against the event description.
 *           Terms with special characters use a substring match; plain terms
 *           use full-text search.
 *       - in: query
 *         name: contract
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter events by contract ID.
 *       - in: query
 *         name: fn
 *         required: false
 *         schema:
 *           type: string
 *         description: Filter events by function name.
 *     responses:
 *       '200':
 *         description: A list of matching events.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       contract_id:
 *                         type: string
 *                       function_name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       ledger:
 *                         type: integer
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *       '500':
 *         description: Failed to fetch events.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to fetch events
 */
router.get('/api/events', async (req: Request, res: Response) => {
  const { q, contract, fn } = req.query as {
    q?: string;
    contract?: string;
    fn?: string;
  };

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (contract) {
    params.push(contract);
    conditions.push(`contract_id = $${params.length}`);
  }

  if (fn) {
    params.push(fn);
    conditions.push(`function_name = $${params.length}`);
  }

  if (q && q.trim().length > 0) {
    const term = q.trim();
    if (SPECIAL_CHARS.test(term)) {
      params.push(`%${term}%`);
      conditions.push(`description ILIKE $${params.length}`);
    } else {
      params.push(term);
      conditions.push(
        `description_tsv @@ plainto_tsquery('english', $${params.length})`
      );
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT id, contract_id, function_name, description, ledger, created_at
         FROM events
         ${where}
        ORDER BY ledger DESC
        LIMIT 100`,
      params
    );
    res.json({ events: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

export default router;