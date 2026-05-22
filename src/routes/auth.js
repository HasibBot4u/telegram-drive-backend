import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Api } from 'telegram';
import { authMiddleware } from '../middleware/auth.js';
import {
  createClient as createTgClient,
  getClient,
  saveSession,
  removeClient,
} from '../telegram/client.js';
import supabase from '../utils/supabase.js';

const router = Router();

// Ephemeral store for pending auth state (apiId/apiHash before full auth)
// userId -> { apiId, apiHash }
const pendingAuth = new Map();

// Ephemeral store for QR login tokens
// userId -> { token, expiresAt }
const qrTokens = new Map();

function issueJWT(userId, supabaseUid, telegramId) {
  return jwt.sign(
    { userId, supabaseUid, telegramId },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function upsertUser(telegramId, firstName, lastName, username) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('users')
      .update({ telegram_username: username || '', telegram_first_name: firstName || '', telegram_last_name: lastName || '', updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from('users')
    .insert({ telegram_id: telegramId, telegram_username: username || '', telegram_first_name: firstName || '', telegram_last_name: lastName || '' })
    .select('id')
    .single();

  if (error) throw error;
  return created.id;
}

// POST /api/auth/connect
router.post('/connect', async (req, res) => {
  try {
    const schema = z.object({ api_id: z.string().min(1), api_hash: z.string().min(1) });
    const { api_id, api_hash } = schema.parse(req.body);

    // Use a temporary key based on IP+timestamp until we have a real userId
    const tempKey = `temp_${req.ip}_${Date.now()}`;
    const client = await createTgClient(tempKey, api_id, api_hash);

    pendingAuth.set(tempKey, { apiId: api_id, apiHash: api_hash, tempKey });

    return res.json({ success: true, sessionKey: tempKey });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    console.error('connect error:', err);
    return res.status(500).json({ error: err.message || 'Failed to connect', code: 'CONNECT_ERROR' });
  }
});

// POST /api/auth/send-code
router.post('/send-code', async (req, res) => {
  try {
    const schema = z.object({ phone: z.string().min(7), session_key: z.string().min(1) });
    const { phone, session_key } = schema.parse(req.body);

    const pending = pendingAuth.get(session_key);
    if (!pending) return res.status(400).json({ error: 'Session not found. Call /connect first.', code: 'NO_SESSION' });

    const client = await getClient(session_key);
    const result = await client.sendCode(
      { apiId: parseInt(pending.apiId, 10), apiHash: pending.apiHash },
      phone
    );

    pendingAuth.set(session_key, { ...pending, phone, phoneCodeHash: result.phoneCodeHash });

    return res.json({ phone_code_hash: result.phoneCodeHash, timeout: result.timeout });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('send-code error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send code', code: 'SEND_CODE_ERROR' });
  }
});

// POST /api/auth/verify-code
router.post('/verify-code', async (req, res) => {
  try {
    const schema = z.object({
      phone: z.string().min(7),
      code: z.string().min(1),
      phone_code_hash: z.string().min(1),
      session_key: z.string().min(1),
    });
    const { phone, code, phone_code_hash, session_key } = schema.parse(req.body);

    const pending = pendingAuth.get(session_key);
    if (!pending) return res.status(400).json({ error: 'Session not found. Call /connect first.', code: 'NO_SESSION' });

    const client = await getClient(session_key);

    let tgUser;
    try {
      tgUser = await client.signIn({ phoneNumber: phone, phoneCodeHash: phone_code_hash, phoneCode: code });
    } catch (err) {
      // SESSION_PASSWORD_NEEDED means 2FA required
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        pendingAuth.set(session_key, { ...pending, needs2FA: true });
        return res.status(200).json({ requires_2fa: true });
      }
      throw err;
    }

    const sessionString = client.session.save();
    const telegramId = tgUser.id.toJSNumber ? tgUser.id.toJSNumber() : Number(tgUser.id);
    const userId = await upsertUser(telegramId, tgUser.firstName, tgUser.lastName, tgUser.username);

    await saveSession(userId, pending.apiId, pending.apiHash, sessionString, phone);

    // Re-register client under real userId
    await createTgClient(userId, pending.apiId, pending.apiHash, sessionString);
    pendingAuth.delete(session_key);

    const token = issueJWT(userId, null, telegramId);
    return res.json({ token, user: { id: userId, telegram_id: telegramId, first_name: tgUser.firstName, last_name: tgUser.lastName, username: tgUser.username } });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('verify-code error:', err);
    return res.status(500).json({ error: err.message || 'Failed to verify code', code: 'VERIFY_CODE_ERROR' });
  }
});

// POST /api/auth/verify-2fa
router.post('/verify-2fa', async (req, res) => {
  try {
    const schema = z.object({ password: z.string().min(1), session_key: z.string().min(1) });
    const { password, session_key } = schema.parse(req.body);

    const pending = pendingAuth.get(session_key);
    if (!pending) return res.status(400).json({ error: 'Session not found', code: 'NO_SESSION' });

    const client = await getClient(session_key);
    const tgUser = await client.signInWithPassword({ password });

    const sessionString = client.session.save();
    const telegramId = tgUser.id.toJSNumber ? tgUser.id.toJSNumber() : Number(tgUser.id);
    const userId = await upsertUser(telegramId, tgUser.firstName, tgUser.lastName, tgUser.username);

    await saveSession(userId, pending.apiId, pending.apiHash, sessionString, pending.phone || '');
    await createTgClient(userId, pending.apiId, pending.apiHash, sessionString);
    pendingAuth.delete(session_key);

    const token = issueJWT(userId, null, telegramId);
    return res.json({ token, user: { id: userId, telegram_id: telegramId, first_name: tgUser.firstName, last_name: tgUser.lastName, username: tgUser.username } });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('verify-2fa error:', err);
    return res.status(500).json({ error: err.message || 'Invalid password', code: 'VERIFY_2FA_ERROR' });
  }
});

// GET /api/auth/qr-generate
router.get('/qr-generate', async (req, res) => {
  try {
    const { api_id, api_hash } = req.query;
    if (!api_id || !api_hash) return res.status(400).json({ error: 'api_id and api_hash required', code: 'VALIDATION_ERROR' });

    const tempKey = `qr_${req.ip}_${Date.now()}`;
    const client = await createTgClient(tempKey, api_id, api_hash);

    const result = await client.invoke(new Api.auth.ExportLoginToken({ apiId: parseInt(api_id, 10), apiHash: api_hash, exceptIds: [] }));

    const tokenBase64 = Buffer.from(result.token).toString('base64url');
    const expiresAt = result.expires * 1000;

    qrTokens.set(tempKey, { token: result.token, expiresAt, apiId: api_id, apiHash: api_hash });

    return res.json({ session_key: tempKey, token: tokenBase64, expires_at: expiresAt });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('qr-generate error:', err);
    return res.status(500).json({ error: err.message || 'Failed to generate QR', code: 'QR_GENERATE_ERROR' });
  }
});

// GET /api/auth/qr-poll
router.get('/qr-poll', async (req, res) => {
  try {
    const { session_key } = req.query;
    if (!session_key) return res.status(400).json({ error: 'session_key required', code: 'VALIDATION_ERROR' });

    const qrData = qrTokens.get(session_key);
    if (!qrData) return res.status(404).json({ error: 'QR session not found', code: 'NOT_FOUND' });

    if (Date.now() > qrData.expiresAt) {
      qrTokens.delete(session_key);
      return res.json({ authorized: false, expired: true });
    }

    const client = await getClient(session_key);
    try {
      const result = await client.invoke(new Api.auth.ImportLoginToken({ token: qrData.token }));
      if (result instanceof Api.auth.LoginTokenSuccess) {
        const tgUser = result.authorization.user;
        const sessionString = client.session.save();
        const telegramId = tgUser.id.toJSNumber ? tgUser.id.toJSNumber() : Number(tgUser.id);
        const userId = await upsertUser(telegramId, tgUser.firstName, tgUser.lastName, tgUser.username);

        await saveSession(userId, qrData.apiId, qrData.apiHash, sessionString, '');
        await createTgClient(userId, qrData.apiId, qrData.apiHash, sessionString);
        qrTokens.delete(session_key);

        const token = issueJWT(userId, null, telegramId);
        return res.json({ authorized: true, token, user: { id: userId, telegram_id: telegramId, first_name: tgUser.firstName, username: tgUser.username } });
      }
    } catch (pollErr) {
      // AUTH_TOKEN_EXPIRED or not yet scanned
      if (pollErr.errorMessage === 'AUTH_TOKEN_EXPIRED') {
        qrTokens.delete(session_key);
        return res.json({ authorized: false, expired: true });
      }
    }

    return res.json({ authorized: false });
  } catch (err) {
    console.error('qr-poll error:', err);
    return res.status(500).json({ error: err.message || 'Poll failed', code: 'QR_POLL_ERROR' });
  }
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    await removeClient(req.user.id);
    await supabase.from('telegram_sessions').delete().eq('user_id', req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(500).json({ error: err.message || 'Logout failed', code: 'LOGOUT_ERROR' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const client = await getClient(req.user.id);
    const tgUser = await client.getMe();

    return res.json({
      id: req.user.id,
      telegram_id: req.user.telegram_id,
      first_name: tgUser.firstName,
      last_name: tgUser.lastName,
      username: tgUser.username,
      phone: tgUser.phone,
    });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get user info', code: 'ME_ERROR' });
  }
});

export default router;
