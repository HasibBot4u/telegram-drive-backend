import { Router } from 'express';
import { z } from 'zod';
import { Api } from 'telegram';
import { authMiddleware } from '../middleware/auth.js';
import { getClient, withFloodWait } from '../telegram/client.js';
import supabase from '../utils/supabase.js';

const router = Router();

function normalizeMessage(msg) {
  if (!msg || !msg.media) return null;
  const doc = msg.media.document || msg.media.photo;
  if (!doc) return null;

  let fileName = 'unknown';
  let mimeType = 'application/octet-stream';
  let fileSize = 0;

  if (msg.media.document) {
    fileSize = doc.size ? (doc.size.toJSNumber ? doc.size.toJSNumber() : Number(doc.size)) : 0;
    mimeType = doc.mimeType || mimeType;
    const nameAttr = (doc.attributes || []).find((a) => a.fileName);
    if (nameAttr) fileName = nameAttr.fileName;
  }

  return {
    message_id: msg.id,
    file_name: fileName,
    mime_type: mimeType,
    file_size: fileSize,
    date: msg.date,
    has_thumb: !!(doc.thumbs && doc.thumbs.length > 0),
  };
}

// GET /api/folders/:chatId/files
router.get('/folders/:chatId/files', async (req, res) => {
  try {
    const chatId = BigInt(req.params.chatId);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offsetId = parseInt(req.query.offset_id || '0', 10);

    const client = await getClient(req.user.id);
    const peer = await withFloodWait(() => client.getInputEntity(chatId));

    const messages = await withFloodWait(() =>
      client.getMessages(peer, {
        limit,
        offsetId: offsetId || 0,
        addOffset: offsetId ? 0 : (page - 1) * limit,
        filter: new Api.InputMessagesFilterDocument(),
      })
    );

    const files = messages.map(normalizeMessage).filter(Boolean);

    return res.json({ files, page, limit, has_more: messages.length === limit });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('list files error:', err);
    return res.status(500).json({ error: err.message || 'Failed to list files', code: 'LIST_FILES_ERROR' });
  }
});

// DELETE /api/files/:chatId/:messageId
router.delete('/files/:chatId/:messageId', async (req, res) => {
  try {
    const chatId = BigInt(req.params.chatId);
    const messageId = parseInt(req.params.messageId, 10);

    const client = await getClient(req.user.id);
    const peer = await withFloodWait(() => client.getInputEntity(chatId));

    await withFloodWait(() =>
      client.deleteMessages(peer, [messageId], { revoke: true })
    );

    // Remove thumbnail cache
    await supabase
      .from('thumbnail_cache')
      .delete()
      .eq('user_id', req.user.id)
      .eq('chat_id', String(chatId))
      .eq('message_id', messageId);

    return res.json({ success: true });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('delete file error:', err);
    return res.status(500).json({ error: err.message || 'Failed to delete file', code: 'DELETE_FILE_ERROR' });
  }
});

// POST /api/files/move
router.post('/files/move', async (req, res) => {
  try {
    const schema = z.object({
      messageIds: z.array(z.number().int()).min(1),
      fromChatId: z.string().min(1),
      toChatId: z.string().min(1),
    });
    const { messageIds, fromChatId, toChatId } = schema.parse(req.body);

    const client = await getClient(req.user.id);
    const fromPeer = await withFloodWait(() => client.getInputEntity(BigInt(fromChatId)));
    const toPeer = await withFloodWait(() => client.getInputEntity(BigInt(toChatId)));

    await withFloodWait(() =>
      client.invoke(new Api.messages.ForwardMessages({
        fromPeer,
        id: messageIds,
        toPeer,
        dropAuthor: true,
      }))
    );

    await withFloodWait(() =>
      client.deleteMessages(fromPeer, messageIds, { revoke: true })
    );

    return res.json({ success: true, moved: messageIds.length });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('move files error:', err);
    return res.status(500).json({ error: err.message || 'Failed to move files', code: 'MOVE_FILES_ERROR' });
  }
});

// GET /api/search?q=query
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q parameter required', code: 'VALIDATION_ERROR' });

    // Get all folders for user
    const { data: folders } = await supabase.from('folders').select('chat_id, name').eq('user_id', req.user.id);
    if (!folders || folders.length === 0) return res.json({ results: [] });

    const client = await getClient(req.user.id);
    const results = [];

    for (const folder of folders) {
      try {
        const peer = await withFloodWait(() => client.getInputEntity(BigInt(folder.chat_id)));
        const messages = await withFloodWait(() =>
          client.getMessages(peer, {
            limit: 50,
            search: q,
            filter: new Api.InputMessagesFilterDocument(),
          })
        );
        const files = messages.map(normalizeMessage).filter(Boolean).map((f) => ({
          ...f,
          chat_id: folder.chat_id,
          folder_name: folder.name,
        }));
        results.push(...files);
      } catch (_) {
        // Skip unreachable chats
      }
    }

    return res.json({ results, query: q });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('search error:', err);
    return res.status(500).json({ error: err.message || 'Search failed', code: 'SEARCH_ERROR' });
  }
});

// GET /api/files/:chatId/:messageId/thumbnail
router.get('/files/:chatId/:messageId/thumbnail', async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const messageId = parseInt(req.params.messageId, 10);

    // Check cache
    const { data: cached } = await supabase
      .from('thumbnail_cache')
      .select('thumbnail_base64')
      .eq('user_id', req.user.id)
      .eq('chat_id', chatId)
      .eq('message_id', messageId)
      .maybeSingle();

    if (cached) {
      return res.json({ thumbnail: cached.thumbnail_base64, cached: true });
    }

    const client = await getClient(req.user.id);
    const peer = await withFloodWait(() => client.getInputEntity(BigInt(chatId)));
    const [msg] = await withFloodWait(() => client.getMessages(peer, { ids: [messageId] }));

    if (!msg || !msg.media) {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }

    const thumbBuffer = await withFloodWait(() =>
      client.downloadMedia(msg, { thumb: 0 })
    );

    if (!thumbBuffer) {
      return res.status(404).json({ error: 'No thumbnail available', code: 'NO_THUMBNAIL' });
    }

    const base64 = Buffer.from(thumbBuffer).toString('base64');
    const mimeType = msg.media?.document?.mimeType || 'image/jpeg';
    const dataUrl = `data:${mimeType.startsWith('image') ? mimeType : 'image/jpeg'};base64,${base64}`;

    // Save to cache
    await supabase.from('thumbnail_cache').upsert({
      user_id: req.user.id,
      chat_id: chatId,
      message_id: messageId,
      thumbnail_base64: dataUrl,
    }, { onConflict: 'user_id,chat_id,message_id' });

    return res.json({ thumbnail: dataUrl, cached: false });
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('thumbnail error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get thumbnail', code: 'THUMBNAIL_ERROR' });
  }
});

export default router;
