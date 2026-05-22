import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { FloodWaitError } from 'telegram/errors/index.js';
import supabase from '../utils/supabase.js';

// userId (internal uuid) -> TelegramClient
const clients = new Map();

// userId -> Map<chatId, InputPeer>
const peerCache = new Map();

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFloodWait(fn, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FloodWaitError) {
        const wait = err.seconds;
        if (attempt < retries - 1 && wait < 60) {
          await sleep(wait * 1000);
          continue;
        }
        throw { floodWait: true, seconds: wait };
      }
      throw err;
    }
  }
}

export async function getClient(userId) {
  if (clients.has(userId)) {
    const client = clients.get(userId);
    if (!client.connected) {
      await client.connect();
    }
    return client;
  }

  // Restore from Supabase
  const { data: session } = await supabase
    .from('telegram_sessions')
    .select('api_id, api_hash, session_string')
    .eq('user_id', userId)
    .maybeSingle();

  if (!session) {
    throw new Error('No session found for user. Please authenticate first.');
  }

  const client = new TelegramClient(
    new StringSession(session.session_string),
    parseInt(session.api_id, 10),
    session.api_hash,
    {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
      useWSS: true,
    }
  );

  await client.connect();
  clients.set(userId, client);
  return client;
}

export async function createClient(userId, apiId, apiHash, sessionString = '') {
  const existing = clients.get(userId);
  if (existing) {
    try {
      await existing.disconnect();
    } catch (_) {}
    clients.delete(userId);
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    parseInt(apiId, 10),
    apiHash,
    {
      connectionRetries: 5,
      retryDelay: 1000,
      autoReconnect: true,
      useWSS: true,
    }
  );

  await client.connect();
  clients.set(userId, client);
  return client;
}

export async function saveSession(userId, apiId, apiHash, sessionString, phone = '') {
  const { data: existing } = await supabase
    .from('telegram_sessions')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('telegram_sessions')
      .update({ session_string: sessionString, api_id: apiId, api_hash: apiHash, phone, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
  } else {
    await supabase.from('telegram_sessions').insert({
      user_id: userId,
      api_id: apiId,
      api_hash: apiHash,
      session_string: sessionString,
      phone,
    });
  }
}

export async function removeClient(userId) {
  const client = clients.get(userId);
  if (client) {
    try {
      await client.disconnect();
    } catch (_) {}
    clients.delete(userId);
  }
  peerCache.delete(userId);
}

export function getPeerCache(userId) {
  if (!peerCache.has(userId)) {
    peerCache.set(userId, new Map());
  }
  return peerCache.get(userId);
}

export async function getInputPeer(userId, chatId) {
  const cache = getPeerCache(userId);
  const key = String(chatId);
  if (cache.has(key)) {
    return cache.get(key);
  }

  const client = await getClient(userId);
  const peer = await withFloodWait(() => client.getInputEntity(chatId));
  cache.set(key, peer);
  return peer;
}
