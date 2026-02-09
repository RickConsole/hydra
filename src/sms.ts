/**
 * SMS server for NanoClaw.
 * HTTP webhook server for Twilio SMS.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { URL } from 'node:url';
import crypto from 'crypto';

import {
  buildSmsJid,
  SMS_ALLOWED_SENDERS,
  SMS_GROUP,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} from './config.js';
import { logger } from './logger.js';

// Callbacks provided by index.ts
type RunAgentFn = (prompt: string, chatJid: string) => Promise<string | null>;
type SendMessageFn = (jid: string, text: string) => Promise<void>;

let runAgentCallback: RunAgentFn;
let sendMessageCallback: SendMessageFn;
let publicUrl = '';
let server: Server | null = null;

// SMS webhook port (offset from voice port)
const SMS_PORT = 3341;

function twiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [key, ...rest] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(rest.join('=').replace(/\+/g, ' '));
    }
  }
  return params;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Validate Twilio webhook signature to prevent spoofed requests.
 */
function validateTwilioSignature(req: IncomingMessage, body: string, url: string): boolean {
  if (!TWILIO_AUTH_TOKEN) {
    logger.warn('Twilio auth token not configured, skipping signature validation');
    return true;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature || typeof signature !== 'string') {
    return false;
  }

  // Build the string to sign: URL + sorted POST params
  const params = parseFormBody(body);
  const sortedKeys = Object.keys(params).sort();
  let dataToSign = url;
  for (const key of sortedKeys) {
    dataToSign += key + params[key];
  }

  const expectedSignature = crypto
    .createHmac('sha1', TWILIO_AUTH_TOKEN)
    .update(dataToSign)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}

function respond(res: ServerResponse, status: number, body: string, contentType = 'text/xml'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

async function handleIncomingSms(params: Record<string, string>, res: ServerResponse): Promise<void> {
  const messageSid = params.MessageSid || '';
  const from = params.From || '';
  const to = params.To || '';
  const body = params.Body || '';

  logger.info({ messageSid, from, to, bodyLength: body.length }, 'Incoming SMS');

  // Check allowlist
  if (SMS_ALLOWED_SENDERS.length > 0 && !SMS_ALLOWED_SENDERS.includes(from)) {
    logger.warn({ from }, 'Rejected SMS from unauthorized number');
    // Don't respond with anything - just ignore
    respond(res, 200, twiml(''));
    return;
  }

  // Acknowledge immediately with empty TwiML (we'll send response via API)
  respond(res, 200, twiml(''));

  // Build JID and run agent
  const smsJid = buildSmsJid(from);

  try {
    const senderName = from; // Could be enhanced with contact lookup
    const timestamp = new Date().toISOString();
    const prompt = `<messages>\n<message sender="${senderName}" time="${timestamp}" channel="sms">${escapeXml(body)}</message>\n</messages>`;

    logger.info({ from, smsJid }, 'Processing SMS message');
    const response = await runAgentCallback(prompt, smsJid);

    if (response) {
      await sendMessageCallback(smsJid, response);
    }
  } catch (err) {
    logger.error({ err, from, messageSid }, 'Error processing SMS');
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/sms/health' && req.method === 'GET') {
    respond(res, 200, JSON.stringify({ status: 'ok' }), 'application/json');
    return;
  }

  // Incoming SMS webhook
  if (pathname === '/sms/incoming' && req.method === 'POST') {
    const body = await readBody(req);
    const fullUrl = `${publicUrl}${pathname}`;

    if (!validateTwilioSignature(req, body, fullUrl)) {
      logger.warn({ path: pathname }, 'Invalid Twilio signature on SMS webhook');
      respond(res, 403, 'Forbidden');
      return;
    }

    const params = parseFormBody(body);
    await handleIncomingSms(params, res);
    return;
  }

  // Status callback (for delivery receipts)
  if (pathname === '/sms/status' && req.method === 'POST') {
    const body = await readBody(req);
    const params = parseFormBody(body);
    const status = params.MessageStatus || 'unknown';
    const messageSid = params.MessageSid || '';

    logger.debug({ messageSid, status }, 'SMS status callback');
    respond(res, 200, '');
    return;
  }

  respond(res, 404, 'Not Found', 'text/plain');
}

/**
 * Send an SMS message via Twilio API.
 */
export async function sendSms(to: string, body: string): Promise<void> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    throw new Error('Twilio credentials not configured for SMS');
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  // Twilio SMS limit is 1600 characters (for concatenated SMS)
  // Split long messages if needed
  const maxLength = 1500; // Leave some room
  const chunks: string[] = [];

  if (body.length <= maxLength) {
    chunks.push(body);
  } else {
    let remaining = body;
    let partNum = 1;
    const totalParts = Math.ceil(body.length / maxLength);

    while (remaining.length > 0) {
      const chunkSize = Math.min(remaining.length, maxLength - 20); // Room for part indicator
      const chunk = remaining.slice(0, chunkSize);
      chunks.push(`[${partNum}/${totalParts}] ${chunk}`);
      remaining = remaining.slice(chunkSize);
      partNum++;
    }
  }

  for (const chunk of chunks) {
    const formData = new URLSearchParams({
      To: to,
      From: TWILIO_PHONE_NUMBER,
      Body: chunk,
      StatusCallback: publicUrl ? `${publicUrl}/sms/status` : '',
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ to, status: response.status, error: errorText }, 'Failed to send SMS');
      throw new Error(`Twilio SMS failed: ${response.status} ${errorText}`);
    }

    const result = await response.json() as { sid: string; status: string };
    logger.info({ to, messageSid: result.sid, status: result.status }, 'SMS sent');

    // Small delay between chunks
    if (chunks.length > 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

export async function startSmsServer(
  runAgent: RunAgentFn,
  sendMessage: SendMessageFn,
  tunnelUrl: string,
): Promise<void> {
  runAgentCallback = runAgent;
  sendMessageCallback = sendMessage;
  publicUrl = tunnelUrl;

  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (err) {
        logger.error({ err, url: req.url }, 'SMS server error');
        respond(res, 500, 'Internal Server Error', 'text/plain');
      }
    });

    server.listen(SMS_PORT, () => {
      logger.info({ port: SMS_PORT, webhookUrl: `${publicUrl}/sms/incoming` }, 'SMS server started');
      resolve();
    });
  });
}

export function stopSmsServer(): void {
  if (server) {
    server.close();
    server = null;
    logger.info('SMS server stopped');
  }
}

export function getSmsWebhookUrl(): string {
  return publicUrl ? `${publicUrl}/sms/incoming` : '';
}
