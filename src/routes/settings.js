import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import supabase from '../utils/supabase.js';

const router = Router();

async function getOrCreateSettings(userId) {
  const { data: existing } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('user_settings')
    .insert({
      user_id: userId,
      max_concurrent_uploads: parseInt(process.env.MAX_CONCURRENT_UPLOADS || '6', 10),
      max_concurrent_downloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '6', 10),
      thumbnail_cache_enabled: true,
      extra: {},
    })
    .select()
    .single();

  if (error) throw error;
  return created;
}

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const settings = await getOrCreateSettings(req.user.id);
    return res.json(settings);
  } catch (err) {
    console.error('get settings error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get settings', code: 'SETTINGS_ERROR' });
  }
});

// PUT /api/settings
router.put('/', async (req, res) => {
  try {
    const schema = z.object({
      max_concurrent_uploads: z.number().int().min(1).max(20).optional(),
      max_concurrent_downloads: z.number().int().min(1).max(20).optional(),
      thumbnail_cache_enabled: z.boolean().optional(),
      extra: z.record(z.unknown()).optional(),
    });
    const updates = schema.parse(req.body);

    await getOrCreateSettings(req.user.id);

    const { data, error } = await supabase
      .from('user_settings')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: err.errors[0].message, code: 'VALIDATION_ERROR' });
    console.error('update settings error:', err);
    return res.status(500).json({ error: err.message || 'Failed to update settings', code: 'SETTINGS_ERROR' });
  }
});

// POST /api/storage/clear-cache
router.post('/storage/clear-cache', async (req, res) => {
  try {
    const { error } = await supabase
      .from('thumbnail_cache')
      .delete()
      .eq('user_id', req.user.id);

    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    console.error('clear cache error:', err);
    return res.status(500).json({ error: err.message || 'Failed to clear cache', code: 'CLEAR_CACHE_ERROR' });
  }
});

// GET /api/storage/info
router.get('/storage/info', async (req, res) => {
  try {
    const { data: thumbs, error } = await supabase
      .from('thumbnail_cache')
      .select('thumbnail_base64')
      .eq('user_id', req.user.id);

    if (error) throw error;

    const totalBytes = (thumbs || []).reduce((acc, t) => acc + (t.thumbnail_base64?.length || 0), 0);
    const count = (thumbs || []).length;

    return res.json({
      thumbnail_count: count,
      cache_size_bytes: totalBytes,
      cache_size_mb: (totalBytes / (1024 * 1024)).toFixed(2),
    });
  } catch (err) {
    console.error('storage info error:', err);
    return res.status(500).json({ error: err.message || 'Failed to get storage info', code: 'STORAGE_INFO_ERROR' });
  }
});

export default router;
