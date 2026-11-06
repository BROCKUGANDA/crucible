// webhook-server.mjs — Minimal receiver for Alchemy webhooks (Address Activity)
// Run: node webhook-server.mjs   then expose via ngrok/cloudflared and register the URL in Alchemy dashboard.
import 'dotenv/config';
import http from 'node:http';

const PORT = process.env.WEBHOOK_PORT || 8790;
const SIGNING_KEY = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY || '';

function verifySignature(rawBody, signature) {
  if (!SIGNING_KEY) return true; // dev mode: skip verification
  // Alchemy sends X-Alchemy-Signature (HMAC-SHA256 of raw body)
  const crypto = await import('node:crypto');
  const hmac = crypto.createHmac('sha256', SIGNING_KEY);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('method not allowed');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  const sig = req.headers['x-alchemy-signature'];
  if (!verifySignature(raw, sig)) {
    res.writeHead(401);
    res.end('bad signature');
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  console.log('webhook received:', JSON.stringify(body).slice(0, 500));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => {
  console.log(`webhook receiver listening on http://localhost:${PORT}`);
  console.log('Register this URL (via tunnel) in the Alchemy dashboard as an Address Activity webhook.');
});
