import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getClient, withFloodWait } from '../telegram/client.js';
import supabase from '../utils/supabase.js';

const router = Router();

// Store active upload controllers for cancellation
// transferId -> AbortController
const activeUploads = new Map();

// SSE clients: transferId -> Set<res>
const sseClients = new Map();

function broadcastProgress(transferId, data) {
  const clients = sseClients.get(transferId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (_) {}
  }
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
});

// POST /api/upload
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  const userId = req.user.id;
  const chatId = req.body?.chatId;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'file field required', code: 'VALIDATION_ERROR' });
  if (!chatId) return res.status(400).json({ error: 'chatId field required', code: 'VALIDATION_ERROR' });

  // Create transfer record
  const { data: transfer, error: dbErr } = await supabase
    .from('active_transfers')
    .insert({
      user_id: userId,
      type: 'upload',
      status: 'pending',
      chat_id: chatId,
      file_name: file.originalname,
      file_size: file.size,
      bytes_transferred: 0,
    })
    .select()
    .single();

  if (dbErr) return res.status(500).json({ error: 'Failed to create transfer record', code: 'DB_ERROR' });

  const transferId = transfer.id;

  // Respond immediately with transferId so client can subscribe to SSE
  res.status(202).json({ transfer_id: transferId, status: 'pending' });

  // Run upload in background
  (async () => {
    try {
      await supabase.from('active_transfers').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', transferId);
      broadcastProgress(transferId, { status: 'in_progress', bytes_transferred: 0, file_size: file.size });

      let isCancelled = false;
      activeUploads.set(transferId, { cancel: () => { isCancelled = true; } });

      const client = await getClient(userId);
      const peer = await withFloodWait(() => client.getInputEntity(BigInt(chatId)));

      let lastBroadcast = 0;
      const uploadedFile = await withFloodWait(() =>
        client.uploadFile({
          file: new File([file.buffer], file.originalname, { type: file.mimetype }),
          workers: 4,
          onProgress: (progress) => {
            if (isCancelled) throw new Error('Upload cancelled by user');
            const bytes = Math.floor(progress * file.size);
            const now = Date.now();
            if (now - lastBroadcast >= 250) {
              lastBroadcast = now;
              broadcastProgress(transferId, { status: 'in_progress', bytes_transferred: bytes, file_size: file.size });
              supabase.from('active_transfers').update({ bytes_transferred: bytes, updated_at: new Date().toISOString() }).eq('id', transferId).then(() => {});
            }
          },
        })
      );

      const result = await withFloodWait(() =>
        client.sendFile(peer, {
          file: uploadedFile,
          caption: file.originalname,
          forceDocument: true,
          attributes: [],
          workers: 4,
        })
      );

      const messageId = result.id;

      await supabase.from('active_transfers').update({
        status: 'completed',
        message_id: messageId,
        bytes_transferred: file.size,
        updated_at: new Date().toISOString(),
      }).eq('id', transferId);

      broadcastProgress(transferId, { status: 'completed', message_id: messageId, bytes_transferred: file.size, file_size: file.size });
    } catch (err) {
      const errMsg = err.floodWait ? `flood_wait:${err.seconds}` : (err.message || 'Upload failed');
      await supabase.from('active_transfers').update({ status: 'failed', error: errMsg, updated_at: new Date().toISOString() }).eq('id', transferId);
      broadcastProgress(transferId, { status: 'failed', error: errMsg });
    } finally {
      activeUploads.delete(transferId);
      // Close SSE connections after a short delay
      setTimeout(() => {
        const clients = sseClients.get(transferId);
        if (clients) {
          for (const c of clients) {
            try { c.end(); } catch (_) {}
          }
          sseClients.delete(transferId);
        }
      }, 2000);
    }
  })();
});

// GET /api/upload/:transferId/progress  (SSE)
router.get('/upload/:transferId/progress', authMiddleware, async (req, res) => {
  const { transferId } = req.params;

  // Verify ownership
  const { data: transfer } = await supabase
    .from('active_transfers')
    .select('id, status, bytes_transferred, file_size, error, message_id')
    .eq('id', transferId)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (!transfer) return res.status(404).json({ error: 'Transfer not found', code: 'NOT_FOUND' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ status: transfer.status, bytes_transferred: transfer.bytes_transferred, file_size: transfer.file_size, error: transfer.error, message_id: transfer.message_id })}\n\n`);

  if (['completed', 'failed', 'cancelled'].includes(transfer.status)) {
    res.end();
    return;
  }

  if (!sseClients.has(transferId)) {
    sseClients.set(transferId, new Set());
  }
  sseClients.get(transferId).add(res);

  req.on('close', () => {
    const clients = sseClients.get(transferId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(transferId);
    }
  });
});

// POST /api/upload/:transferId/cancel
router.post('/upload/:transferId/cancel', authMiddleware, async (req, res) => {
  try {
    const { transferId } = req.params;

    const { data: transfer } = await supabase
      .from('active_transfers')
      .select('id, status')
      .eq('id', transferId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!transfer) return res.status(404).json({ error: 'Transfer not found', code: 'NOT_FOUND' });
    if (['completed', 'cancelled', 'failed'].includes(transfer.status)) {
      return res.status(400).json({ error: 'Transfer already finished', code: 'ALREADY_FINISHED' });
    }

    const ac = activeUploads.get(transferId);
    if (ac) ac.cancel();

    await supabase.from('active_transfers').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', transferId);
    broadcastProgress(transferId, { status: 'cancelled' });

    return res.json({ success: true });
  } catch (err) {
    console.error('cancel upload error:', err);
    return res.status(500).json({ error: err.message || 'Cancel failed', code: 'CANCEL_ERROR' });
  }
});

// POST /api/upload/:transferId/retry
router.post('/upload/:transferId/retry', authMiddleware, async (req, res) => {
  try {
    const { transferId } = req.params;

    const { data: transfer } = await supabase
      .from('active_transfers')
      .select('*')
      .eq('id', transferId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!transfer) return res.status(404).json({ error: 'Transfer not found', code: 'NOT_FOUND' });
    if (transfer.status !== 'failed') return res.status(400).json({ error: 'Only failed transfers can be retried', code: 'NOT_FAILED' });

    await supabase.from('active_transfers').update({ status: 'pending', error: '', bytes_transferred: 0, updated_at: new Date().toISOString() }).eq('id', transferId);

    return res.json({ success: true, message: 'Re-upload the file to /api/upload with the same chatId' });
  } catch (err) {
    console.error('retry error:', err);
    return res.status(500).json({ error: err.message || 'Retry failed', code: 'RETRY_ERROR' });
  }
});

// GET /api/download/:chatId/:messageId
router.get('/download/:chatId/:messageId', authMiddleware, async (req, res) => {
  try {
    const chatId = BigInt(req.params.chatId);
    const messageId = parseInt(req.params.messageId, 10);

    const client = await getClient(req.user.id);
    const peer = await withFloodWait(() => client.getInputEntity(chatId));
    const [msg] = await withFloodWait(() => client.getMessages(peer, { ids: [messageId] }));

    if (!msg || !msg.media) return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });

    const doc = msg.media.document;
    const fileSize = doc ? (doc.size.toJSNumber ? doc.size.toJSNumber() : Number(doc.size)) : 0;
    const mimeType = doc?.mimeType || 'application/octet-stream';
    const nameAttr = (doc?.attributes || []).find((a) => a.fileName);
    const fileName = nameAttr?.fileName || `file_${messageId}`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    if (fileSize > 0) res.setHeader('Content-Length', fileSize);

    const buffer = await withFloodWait(() => client.downloadMedia(msg, {}));
    res.end(buffer);
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('download error:', err);
    return res.status(500).json({ error: err.message || 'Download failed', code: 'DOWNLOAD_ERROR' });
  }
});

// GET /api/stream/:chatId/:messageId  (range-aware streaming)
router.get('/stream/:chatId/:messageId', authMiddleware, async (req, res) => {
  try {
    const chatId = BigInt(req.params.chatId);
    const messageId = parseInt(req.params.messageId, 10);

    const client = await getClient(req.user.id);
    const peer = await withFloodWait(() => client.getInputEntity(chatId));
    const [msg] = await withFloodWait(() => client.getMessages(peer, { ids: [messageId] }));

    if (!msg || !msg.media) return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });

    const doc = msg.media.document;
    const fileSize = doc ? (doc.size.toJSNumber ? doc.size.toJSNumber() : Number(doc.size)) : 0;
    const mimeType = doc?.mimeType || 'application/octet-stream';

    const rangeHeader = req.headers.range;

    if (rangeHeader && fileSize > 0) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', mimeType);

      // Download the specific range
      const buffer = await withFloodWait(() =>
        client.downloadMedia(msg, {
          start,
          end: end + 1,
        })
      );
      res.end(buffer);
    } else {
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      if (fileSize > 0) res.setHeader('Content-Length', fileSize);

      const buffer = await withFloodWait(() => client.downloadMedia(msg, {}));
      res.end(buffer);
    }
  } catch (err) {
    if (err.floodWait) return res.status(429).json({ error: 'flood_wait', seconds: err.seconds, code: 'FLOOD_WAIT' });
    console.error('stream error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'Stream failed', code: 'STREAM_ERROR' });
    }
  }
});

export default router;
