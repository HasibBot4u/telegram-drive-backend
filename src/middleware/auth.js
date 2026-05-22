import jwt from 'jsonwebtoken';
import supabase from '../utils/supabase.js';

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, telegram_id, telegram_username, telegram_first_name, telegram_last_name')
    .eq('id', payload.userId)
    .maybeSingle();

  if (error || !user) {
    return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  }

  req.user = { ...user, supabaseUid: payload.supabaseUid };
  next();
}
