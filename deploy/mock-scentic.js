/**
 * Mock Scentic webhook receiver — LOCAL DEVELOPMENT ONLY.
 *
 * Receives gateway webhook events at POST /webhook.
 * Verifies HMAC-SHA256 signature from X-Gateway-Signature header.
 * Logs event details, responds 200 OK.
 *
 * Health endpoint: GET /health
 * Events log: GET /events
 *
 * NOT for production. Production uses the real Scentic core webhook receiver.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = process.env.MOCK_SCENTIC_PORT || 3199;
const HMAC_SECRET = process.env.SCENTIC_WEBHOOK_HMAC_SECRET || 'dev-webhook-hmac-secret';

const receivedEvents = [];

const server = http.createServer((req, res) => {
  // CORS headers for local testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gateway-Signature, X-Gateway-Timestamp, X-Gateway-Nonce, X-Gateway-Event-Id, X-Gateway-Firm-Id, X-Gateway-Event-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'mock-scentic', eventsReceived: receivedEvents.length }));
    return;
  }

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: receivedEvents }));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const signature = req.headers['x-gateway-signature'] || '';
      const timestamp = req.headers['x-gateway-timestamp'] || '';
      const nonce = req.headers['x-gateway-nonce'] || '';
      const eventId = req.headers['x-gateway-event-id'] || '';
      const firmId = req.headers['x-gateway-firm-id'] || '';
      const eventType = req.headers['x-gateway-event-type'] || '';

      // Verify HMAC signature
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');
      const sigValid = signature === expectedSig;

      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

      const event = {
        eventId,
        eventType,
        firmId,
        timestamp,
        nonce,
        signatureValid: sigValid,
        receivedAt: new Date().toISOString(),
        payload: parsed,
      };

      receivedEvents.push(event);
      console.log(`[mock-scentic] Event ${eventId} type=${eventType} firm=${firmId} sigValid=${sigValid}`);

      // Check for forbidden fields in payload
      const forbiddenFields = ['signingLink', 'documentContent', 'rawEmail', 'apiToken', 'masterKey', 'password'];
      const found = forbiddenFields.filter(f => JSON.stringify(parsed).includes(f));
      if (found.length > 0) {
        console.warn(`[mock-scentic] WARNING: Forbidden fields in payload: ${found.join(', ')}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, eventId, signatureValid: sigValid }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[mock-scentic] Listening on port ${PORT}`);
  console.log(`[mock-scentic] Webhook endpoint: POST /webhook`);
  console.log(`[mock-scentic] Health: GET /health`);
  console.log(`[mock-scentic] Events log: GET /events`);
});
