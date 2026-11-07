// webhook-server.mjs — Minimal authenticated Alchemy webhook receiver.
// This demo validates delivery authenticity and payload shape. It is NOT a durable
// production event processor: production ingestion must persist an idempotent inbox
// record, then reconcile every log against canonical RPC data and finality.
import 'dotenv/config';
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.WEBHOOK_PORT || 8790);
const SIGNING_KEY = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY || '';
const MAX_BODY_BYTES = 1_048_576;
const ALLOW_UNSIGNED_DEV =
  process.env.NODE_ENV !== 'production' &&
  process.env.ALCHEMY_WEBHOOK_ALLOW_UNSIGNED_DEV === '1';

function verifySignature(rawBody, suppliedSignature) {
  if (!SIGNING_KEY) return ALLOW_UNSIGNED_DEV;
  if (typeof suppliedSignature !== 'string' || suppliedSignature.length === 0) return false;

  const supplied = suppliedSignature.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;

  const expected = createHmac('sha256', SIGNING_KEY).update(rawBody).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, mode: 'signature-verified-demo-receiver' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request body could not be read' }));
    }
    return;
  }

  const raw = Buffer.concat(chunks);
  const signature = req.headers['x-alchemy-signature'];
  if (!verifySignature(raw, Array.isArray(signature) ? signature[0] : signature)) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'invalid webhook signature' }));
    return;
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON payload' }));
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected payload shape' }));
    return;
  }

  // Acknowledge only after signature and shape validation. The next production
  // step is a durable inbox/outbox transaction, not treating this log as storage.
  console.log('verified webhook received:', JSON.stringify(body).slice(0, 500));
  res.writeHead(202, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ accepted: true, durable: false }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`webhook receiver listening on port ${PORT}`);
  if (!SIGNING_KEY && !ALLOW_UNSIGNED_DEV) {
    console.error('ALCHEMY_WEBHOOK_SIGNING_KEY is missing; all webhook deliveries will be rejected');
  }
});
