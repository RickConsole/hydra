/**
 * ElevenLabs TTS client for NanoClaw voice calling.
 * Synthesizes text to MP3, manages audio file lifecycle.
 */
import fs from 'fs';
import path from 'path';

import {
  ELEVENLABS_API_KEY,
  ELEVENLABS_MODEL_ID,
  ELEVENLABS_VOICE_ID,
  VOICE_AUDIO_DIR,
  VOICE_GREETING,
} from './config.js';
import { logger } from './logger.js';

const FILLER_PHRASES = [
  'Let me think about that.',
  'One moment.',
  'Working on it.',
];

// Audio files older than this are cleaned up
const AUDIO_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export async function synthesize(text: string, filename?: string): Promise<string> {
  const id = filename || `resp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const filePath = path.join(VOICE_AUDIO_DIR, `${id}.mp3`);

  if (fs.existsSync(filePath)) return filePath;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${body}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  logger.info({ filePath, textLength: text.length }, 'TTS audio synthesized');
  return filePath;
}

export async function preRenderAudio(): Promise<void> {
  fs.mkdirSync(VOICE_AUDIO_DIR, { recursive: true });

  const renders: Array<{ name: string; text: string }> = [
    { name: 'greeting', text: VOICE_GREETING },
    ...FILLER_PHRASES.map((text, i) => ({ name: `filler-${i}`, text })),
  ];

  for (const { name, text } of renders) {
    try {
      await synthesize(text, name);
      logger.info({ name }, 'Pre-rendered audio ready');
    } catch (err) {
      logger.error({ name, err }, 'Failed to pre-render audio');
    }
  }
}

export function getFillerAudioPath(): string {
  const index = Math.floor(Math.random() * FILLER_PHRASES.length);
  const filePath = path.join(VOICE_AUDIO_DIR, `filler-${index}.mp3`);
  if (fs.existsSync(filePath)) return filePath;
  // Fallback to first filler
  return path.join(VOICE_AUDIO_DIR, 'filler-0.mp3');
}

export function getGreetingAudioPath(): string {
  return path.join(VOICE_AUDIO_DIR, 'greeting.mp3');
}

export function cleanupExpiredAudio(): void {
  if (!fs.existsSync(VOICE_AUDIO_DIR)) return;
  const now = Date.now();
  const files = fs.readdirSync(VOICE_AUDIO_DIR);

  for (const file of files) {
    // Don't delete pre-rendered files
    if (file.startsWith('greeting') || file.startsWith('filler-')) continue;

    const filePath = path.join(VOICE_AUDIO_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > AUDIO_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        logger.debug({ file }, 'Cleaned up expired audio');
      }
    } catch {
      // Ignore errors during cleanup
    }
  }
}
