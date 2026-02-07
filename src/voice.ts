/**
 * Voice calling server for NanoClaw.
 * HTTP webhook server for Twilio TwiML-based voice flow.
 * No WebSockets — Twilio handles all audio transport.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { URL } from 'node:url';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  buildVoiceJid,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  VOICE_ALLOWED_CALLERS,
  VOICE_AUDIO_DIR,
  VOICE_MAX_DURATION,
  VOICE_PORT,
} from './config.js';
import { logger } from './logger.js';
import {
  cleanupExpiredAudio,
  getFillerAudioPath,
  getGreetingAudioPath,
  preRenderAudio,
  synthesize,
} from './voice-tts.js';
import { startTunnel, stopTunnel } from './voice-tunnel.js';
import { ActiveCall } from './types.js';

// Callbacks provided by index.ts
type RunAgentFn = (prompt: string, chatJid: string) => Promise<string | null>;
type SendMessageFn = (jid: string, text: string) => Promise<void>;

let runAgentCallback: RunAgentFn;
let sendMessageCallback: SendMessageFn;
let publicUrl = '';
let server: Server | null = null;

// Active calls map
const activeCalls = new Map<string, ActiveCall>();

// Stuck call sweeper interval
let sweeperInterval: ReturnType<typeof setInterval> | null = null;
// Audio cleanup interval
let audioCleanupInterval: ReturnType<typeof setInterval> | null = null;

const STUCK_CALL_TIMEOUT = 45 * 1000; // 45 seconds no activity = stuck
const SWEEPER_INTERVAL = 30 * 1000; // check every 30s

function twiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function audioUrl(filePath: string): string {
  const filename = path.basename(filePath);
  return `${publicUrl}/voice/audio/${filename}`;
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
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
function validateTwilioSignature(req: IncomingMessage, body: string, url: string): boolean {
  if (!TWILIO_AUTH_TOKEN) return true; // Skip validation if no auth token

  const signature = req.headers['x-twilio-signature'] as string;
  if (!signature) return false;

  const params = parseFormBody(body);
  // Build the data string: URL + sorted params
  let data = url;
  const sortedKeys = Object.keys(params).sort();
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto
    .createHmac('sha1', TWILIO_AUTH_TOKEN)
    .update(data)
    .digest('base64');

  return signature === expected;
}

function cleanupCall(callSid: string): void {
  const call = activeCalls.get(callSid);
  if (call) {
    call.state = 'ended';
    activeCalls.delete(callSid);
    logger.info(
      { callSid, callerNumber: call.callerNumber, duration: Date.now() - call.startedAt },
      'Call cleaned up',
    );
  }
}

function sweepStuckCalls(): void {
  const now = Date.now();
  for (const [callSid, call] of activeCalls) {
    if (now - call.lastActivity > STUCK_CALL_TIMEOUT) {
      logger.warn({ callSid, state: call.state, idleMs: now - call.lastActivity }, 'Sweeping stuck call');
      cleanupCall(callSid);
    }
    if (now - call.startedAt > VOICE_MAX_DURATION) {
      logger.warn({ callSid, durationMs: now - call.startedAt }, 'Sweeping max-duration call');
      cleanupCall(callSid);
    }
  }
}

/**
 * Check if the call is already completed/hung-up based on Twilio's CallStatus param.
 * Twilio sends CallStatus with every webhook request. If the caller hung up,
 * clean up immediately rather than waiting for a status callback.
 */
function checkCallEnded(params: Record<string, string>): boolean {
  const callStatus = params.CallStatus || '';
  const callSid = params.CallSid || params.callSid || '';
  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
    if (callSid) cleanupCall(callSid);
    return true;
  }
  return false;
}

function respond(res: ServerResponse, statusCode: number, body: string, contentType = 'application/xml'): void {
  res.writeHead(statusCode, { 'Content-Type': contentType });
  res.end(body);
}

function handleIncoming(params: Record<string, string>, res: ServerResponse): void {
  const callSid = params.CallSid || '';
  const callerNumber = params.From || '';

  logger.info({ callSid, callerNumber }, 'Incoming voice call');

  // Check allowlist
  if (VOICE_ALLOWED_CALLERS.length > 0 && !VOICE_ALLOWED_CALLERS.includes(callerNumber)) {
    logger.warn({ callerNumber }, 'Rejected call from unauthorized number');
    respond(res, 200, twiml('<Say>Sorry, this number is not authorized.</Say><Hangup/>'));
    return;
  }

  // Check concurrent calls (max 1)
  if (activeCalls.size > 0) {
    logger.warn({ callSid, activeCalls: activeCalls.size }, 'Rejected call: already have active call');
    respond(res, 200, twiml('<Say>Sorry, the line is busy. Please try again later.</Say><Hangup/>'));
    return;
  }

  // Register the call
  const now = Date.now();
  activeCalls.set(callSid, {
    callSid,
    callerNumber,
    state: 'greeting',
    startedAt: now,
    lastActivity: now,
  });

  const greetingUrl = audioUrl(getGreetingAudioPath());
  const gatherAction = `${publicUrl}/voice/gather?callSid=${encodeURIComponent(callSid)}`;
  const statusCallbackUrl = `${publicUrl}/voice/status`;

  respond(res, 200, twiml(
    `<Play>${escapeXml(greetingUrl)}</Play>` +
    `<Gather input="speech" speechTimeout="auto" action="${escapeXml(gatherAction)}" method="POST">` +
    `<Pause length="30"/>` +
    `</Gather>` +
    `<Say>I didn't hear anything. Goodbye.</Say><Hangup/>`,
  ));

  // Configure status callback via Twilio REST API so we get notified on hangup
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    const updateUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    fetch(updateUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `StatusCallback=${encodeURIComponent(statusCallbackUrl)}&StatusCallbackEvent=completed`,
    }).catch((err) => {
      logger.warn({ callSid, err }, 'Failed to set status callback on call');
    });
  }

  // Update state
  const call = activeCalls.get(callSid);
  if (call) {
    call.state = 'gathering';
    call.lastActivity = Date.now();
  }
}

async function handleGather(params: Record<string, string>, res: ServerResponse): Promise<void> {
  if (checkCallEnded(params)) {
    respond(res, 200, twiml(''));
    return;
  }

  const callSid = params.callSid || params.CallSid || '';
  const speechResult = params.SpeechResult || '';

  const call = activeCalls.get(callSid);
  if (!call) {
    logger.warn({ callSid }, 'Gather received for unknown call');
    respond(res, 200, twiml('<Say>Sorry, an error occurred.</Say><Hangup/>'));
    return;
  }

  call.lastActivity = Date.now();
  call.state = 'processing';

  logger.info({ callSid, speechResult }, 'Speech transcribed');

  if (!speechResult) {
    // No speech detected, go back to gathering
    call.state = 'gathering';
    const gatherAction = `${publicUrl}/voice/gather?callSid=${encodeURIComponent(callSid)}`;
    respond(res, 200, twiml(
      `<Say>I didn't catch that. Could you repeat?</Say>` +
      `<Gather input="speech" speechTimeout="auto" action="${escapeXml(gatherAction)}" method="POST">` +
      `<Pause length="30"/>` +
      `</Gather>` +
      `<Say>Still nothing. Goodbye.</Say><Hangup/>`,
    ));
    return;
  }

  // Play thinking filler and redirect to poll loop
  const fillerUrl = audioUrl(getFillerAudioPath());
  const pollUrl = `${publicUrl}/voice/poll/${encodeURIComponent(callSid)}`;

  respond(res, 200, twiml(
    `<Play>${escapeXml(fillerUrl)}</Play>` +
    `<Redirect method="POST">${escapeXml(pollUrl)}</Redirect>`,
  ));

  // Fire off agent processing in background
  processAgentInBackground(call, speechResult).catch((err) => {
    logger.error({ callSid, err }, 'Background agent processing failed');
  });
}

async function processAgentInBackground(call: ActiveCall, speechResult: string): Promise<void> {
  const chatJid = buildVoiceJid(call.callSid);
  const timestamp = new Date().toISOString();
  const callerDisplay = call.callerNumber;

  const prompt = `<messages>\n<message sender="Voice Call (${callerDisplay})" time="${timestamp}" channel="voice">${escapeXml(speechResult)}</message>\n</messages>`;

  try {
    const response = await runAgentCallback(prompt, chatJid);
    if (response && activeCalls.has(call.callSid)) {
      // Synthesize response to MP3
      const audioPath = await synthesize(response);
      call.pendingResponse = audioPath;
      call.pendingResponseText = response;
      call.lastActivity = Date.now();
      logger.info({ callSid: call.callSid, responseLength: response.length }, 'Agent response ready');
    }
  } catch (err) {
    logger.error({ callSid: call.callSid, err }, 'Agent processing failed');
    // Try to synthesize an error message
    try {
      const errorPath = await synthesize('Sorry, I had trouble processing that. Could you try again?');
      if (activeCalls.has(call.callSid)) {
        call.pendingResponse = errorPath;
        call.lastActivity = Date.now();
      }
    } catch {
      // If even error TTS fails, the poll loop will eventually time out
    }
  }
}

function handlePoll(callSid: string, params: Record<string, string>, res: ServerResponse): void {
  if (checkCallEnded(params)) {
    respond(res, 200, twiml(''));
    return;
  }

  const call = activeCalls.get(callSid);
  if (!call) {
    logger.warn({ callSid }, 'Poll for unknown call');
    respond(res, 200, twiml('<Say>Sorry, an error occurred.</Say><Hangup/>'));
    return;
  }

  call.lastActivity = Date.now();

  if (call.pendingResponse) {
    // Response is ready — play it and go back to gathering
    const responseUrl = audioUrl(call.pendingResponse);
    const gatherAction = `${publicUrl}/voice/gather?callSid=${encodeURIComponent(callSid)}`;

    logger.info({ callSid, responseText: call.pendingResponseText?.slice(0, 100) }, 'Playing response');

    call.pendingResponse = undefined;
    call.pendingResponseText = undefined;
    call.state = 'gathering';

    respond(res, 200, twiml(
      `<Play>${escapeXml(responseUrl)}</Play>` +
      `<Gather input="speech" speechTimeout="auto" action="${escapeXml(gatherAction)}" method="POST">` +
      `<Pause length="30"/>` +
      `</Gather>` +
      `<Say>Are you still there? Goodbye.</Say><Hangup/>`,
    ));
  } else {
    // Not ready yet, wait and redirect back
    const pollUrl = `${publicUrl}/voice/poll/${encodeURIComponent(callSid)}`;
    respond(res, 200, twiml(
      `<Pause length="2"/>` +
      `<Redirect method="POST">${escapeXml(pollUrl)}</Redirect>`,
    ));
  }
}

function handleStatus(params: Record<string, string>, res: ServerResponse): void {
  const callSid = params.CallSid || '';
  const callStatus = params.CallStatus || '';

  logger.info({ callSid, callStatus }, 'Call status update');

  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(callStatus)) {
    cleanupCall(callSid);
  }

  respond(res, 200, twiml(''));
}

function handleAudio(filename: string, res: ServerResponse): void {
  const safeName = path.basename(filename); // Prevent path traversal
  const filePath = path.join(VOICE_AUDIO_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Queue a TTS response for an active voice call.
 * Called from sendMessage() in index.ts when the JID is a voice JID.
 */
export async function queueVoiceResponse(callSid: string, text: string): Promise<void> {
  const call = activeCalls.get(callSid);
  if (!call) {
    logger.warn({ callSid }, 'Cannot queue voice response: call not found');
    return;
  }

  try {
    const audioPath = await synthesize(text);
    call.pendingResponse = audioPath;
    call.pendingResponseText = text;
    call.lastActivity = Date.now();
    logger.info({ callSid, textLength: text.length }, 'Voice response queued');
  } catch (err) {
    logger.error({ callSid, err }, 'Failed to synthesize voice response');
  }
}

export async function startVoiceServer(
  onRunAgent: RunAgentFn,
  onSendMessage: SendMessageFn,
): Promise<void> {
  runAgentCallback = onRunAgent;
  sendMessageCallback = onSendMessage;

  // Pre-render greeting and filler audio
  await preRenderAudio();

  // Start ngrok tunnel
  publicUrl = await startTunnel();
  logger.info({ publicUrl }, 'Voice webhook URL ready');

  // Start HTTP server
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${VOICE_PORT}`);
      const pathname = url.pathname;

      // Serve audio files (GET)
      if (req.method === 'GET' && pathname.startsWith('/voice/audio/')) {
        const filename = pathname.slice('/voice/audio/'.length);
        handleAudio(filename, res);
        return;
      }

      // All other routes are POST
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      const body = await readBody(req);
      const fullUrl = `${publicUrl}${req.url}`;

      // Validate Twilio signature
      if (!validateTwilioSignature(req, body, fullUrl)) {
        logger.warn({ pathname }, 'Invalid Twilio signature');
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const params = parseFormBody(body);
      // Merge query params
      for (const [key, value] of url.searchParams) {
        if (!params[key]) params[key] = value;
      }

      if (pathname === '/voice/incoming') {
        handleIncoming(params, res);
      } else if (pathname === '/voice/gather') {
        await handleGather(params, res);
      } else if (pathname === '/voice/status') {
        handleStatus(params, res);
      } else if (pathname.startsWith('/voice/poll/')) {
        const callSid = decodeURIComponent(pathname.slice('/voice/poll/'.length));
        handlePoll(callSid, params, res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (err) {
      logger.error({ err, url: req.url }, 'Voice webhook error');
      try {
        respond(res, 200, twiml('<Say>Sorry, an error occurred.</Say><Hangup/>'));
      } catch {
        res.writeHead(500);
        res.end('Internal error');
      }
    }
  });

  server.listen(VOICE_PORT, () => {
    logger.info({ port: VOICE_PORT, publicUrl }, 'Voice server listening');
  });

  // Start stuck call sweeper
  sweeperInterval = setInterval(sweepStuckCalls, SWEEPER_INTERVAL);

  // Start audio cleanup (every 10 minutes)
  audioCleanupInterval = setInterval(cleanupExpiredAudio, 10 * 60 * 1000);
}

export function stopVoiceServer(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
  if (audioCleanupInterval) {
    clearInterval(audioCleanupInterval);
    audioCleanupInterval = null;
  }

  // Clean up all active calls
  for (const callSid of activeCalls.keys()) {
    cleanupCall(callSid);
  }

  if (server) {
    server.close();
    server = null;
  }

  stopTunnel();
  logger.info('Voice server stopped');
}
