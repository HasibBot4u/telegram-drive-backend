import { Router } from 'express';
import { z } from 'zod';
import { Api } from 'telegram';
import { authMiddleware } from '../middleware/auth.js';
import { getClient, withFloodWait, getPeerCache } from '../telegram/client.js';
import supabase from '../utils/supabase.js';

const router = Router();

const FOLDER_TAG = '[telegram-drive-folder]';

async function discoverFolders(userId) {
  const client = await getClient(userId);
  const dialogs = await withFloodWait(() => client.getDialogs({ limit: 200 }));

  const driveFolders = dialogs.filter((d) => {
    const title = d.title || '';
    return (d.isChannel || d.isGroup) && title.includes(FOLDER_TAG);
  });

  const rows = driveFolders.map((d) => ({
    user_id: userId,
    chat_id: d.id.toJSNumber ? d.id.toJSNumber() : Number(d.id),
    name: (d.title || '').replace(FOLDER_TAG, '').trim(),
  }));

  if (rows.length > 0) {
    await supabase.from('folders').upsert(rows, { onConflict: 'user_id,chat_id' });
  }

  return rows;
}

// GET /api/folders
router.get('/', async (req, res) => {
  try {
    const { data: folders, error } = await supabase
      .from('folders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    if (folders.length === 0) {
      const discovered = await discoverFolders(req.user.id);
      return res.json(discovered);
    }

    return res.json(folders);
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('list folders error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list folders', code: 'LIST_FOLDERS_ERROR' });
  }
});

// POST /api/folders
router.post('/', async (req, res) => {
  try {
    const schema = z.object({ name: z.string().min(1).max(200) });
    const { name } = schema.parse(req.body);

    const client = await getClient(req.user.id);
    const channelTitle = `${name} ${FOLDER_TAG}`;

    const result = await withFloodWait(() =>
      client.invoke(new Api.channels.CreateChannel({
        title: channelTitle,
        about: 'Telegram Drive folder',
        megagroup: false,
        broadcast: false,
      }))
    );

    const chat = result.chats[0];
    const chatId = chat.id.toJSNumber ? chat.id.toJSNumber() : Number(chat.id);

    const { data: folder, error } = await supabase
      .from('folders')
      .insert({ user_id: req.user.id, chat_id: chatId, name })
      .select()
      .single();

    if (error) throw error;

    // Cache the peer
    const peerCache = getPeerCache(req.user.id);
    peerCache.set(String(chatId), await client.getInputEntity(chatId));

    return res.status(201).json(folder);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('create folder error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create folder', code: 'CREATE_FOLDER_ERROR' });
  }
});

// DELETE /api/folders/:chatId
router.delete('/:chatId', async (req, res) => {
  try {
    const chatId = BigInt(req.params.chatId);

    const client = await getClient(req.user.id);
    const peer = await client.getInputEntity(chatId);

    try {
      await withFloodWait(() =>
        client.invoke(new Api.channels.DeleteChannel({ channel: peer }))
      );
    } catch (tgErr) {
      // If we're not the owner, try leaving instead
      if (tgErr.errorMessage === 'CHAT_ADMIN_REQUIRED' || tgErr.errorMessage === 'CHANNEL_PRIVATE') {
        await withFloodWait(() => client.invoke(new Api.channels.LeaveChannel({ channel: peer })));
      } else {
        throw tgErr;
      }
    }

    await supabase.from('folders').delete().eq('user_id', req.user.id).eq('chat_id', String(chatId));

    const peerCache = getPeerCache(req.user.id);
    peerCache.delete(String(chatId));

    return res.json({ success: true });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('delete folder error:', err);
    return res.status(500).json({ error: err.message || 'Failed to delete folder', code: 'DELETE_FOLDER_ERROR' });
  }
});

// POST /api/folders/sync
router.post('/sync', async (req, res) => {
  try {
    // Clear existing and re-discover
    await supabase.from('folders').delete().eq('user_id', req.user.id);
    const discovered = await discoverFolders(req.user.id);
    return res.json({ synced: discovered.length, folders: discovered });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('sync folders error:', err);
    return res.status(500).json({ error: err.message || 'Sync failed', code: 'SYNC_ERROR' });
  }
});

export default router;
