/*
  # Telegram Drive - Full Schema

  1. New Tables
    - `users`
      - `id` (uuid, primary key) - internal user ID
      - `supabase_uid` (uuid, unique) - links to Supabase auth if used
      - `telegram_id` (bigint, unique) - Telegram user ID
      - `telegram_username` (text) - Telegram username
      - `telegram_first_name` (text)
      - `telegram_last_name` (text)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `telegram_sessions`
      - `id` (uuid, primary key)
      - `user_id` (uuid, FK -> users)
      - `api_id` (text) - Telegram API ID
      - `api_hash` (text) - Telegram API hash
      - `session_string` (text) - GramJS StringSession
      - `phone` (text)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `folders`
      - `id` (uuid, primary key)
      - `user_id` (uuid, FK -> users)
      - `chat_id` (bigint) - Telegram channel/chat ID
      - `name` (text)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `active_transfers`
      - `id` (uuid, primary key) - transfer ID used as SSE stream key
      - `user_id` (uuid, FK -> users)
      - `type` (text) - 'upload' or 'download'
      - `status` (text) - 'pending', 'in_progress', 'completed', 'failed', 'cancelled'
      - `chat_id` (bigint)
      - `message_id` (bigint) - set after upload completes
      - `file_name` (text)
      - `file_size` (bigint)
      - `bytes_transferred` (bigint)
      - `error` (text)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `user_settings`
      - `id` (uuid, primary key)
      - `user_id` (uuid, unique, FK -> users)
      - `max_concurrent_uploads` (int)
      - `max_concurrent_downloads` (int)
      - `thumbnail_cache_enabled` (boolean)
      - `extra` (jsonb)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `thumbnail_cache`
      - `id` (uuid, primary key)
      - `user_id` (uuid, FK -> users)
      - `chat_id` (bigint)
      - `message_id` (bigint)
      - `thumbnail_base64` (text)
      - `created_at` (timestamptz)

  2. Security
    - RLS enabled on all tables
    - Service role bypasses RLS (backend uses service key)
    - Authenticated users can only access their own rows
*/

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_uid uuid UNIQUE,
  telegram_id bigint UNIQUE NOT NULL,
  telegram_username text DEFAULT '',
  telegram_first_name text DEFAULT '',
  telegram_last_name text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own row"
  ON users FOR SELECT
  TO authenticated
  USING (supabase_uid = auth.uid());

CREATE POLICY "Users can update own row"
  ON users FOR UPDATE
  TO authenticated
  USING (supabase_uid = auth.uid())
  WITH CHECK (supabase_uid = auth.uid());

-- Telegram sessions table
CREATE TABLE IF NOT EXISTS telegram_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_id text NOT NULL DEFAULT '',
  api_hash text NOT NULL DEFAULT '',
  session_string text NOT NULL DEFAULT '',
  phone text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_sessions_user_id ON telegram_sessions(user_id);

ALTER TABLE telegram_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own sessions"
  ON telegram_sessions FOR SELECT
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

-- Folders table
CREATE TABLE IF NOT EXISTS folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  name text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own folders"
  ON folders FOR SELECT
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

CREATE POLICY "Users can insert own folders"
  ON folders FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

CREATE POLICY "Users can update own folders"
  ON folders FOR UPDATE
  TO authenticated
  USING (user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()))
  WITH CHECK (user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()));

CREATE POLICY "Users can delete own folders"
  ON folders FOR DELETE
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

-- Active transfers table
CREATE TABLE IF NOT EXISTS active_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'upload',
  status text NOT NULL DEFAULT 'pending',
  chat_id bigint,
  message_id bigint,
  file_name text DEFAULT '',
  file_size bigint DEFAULT 0,
  bytes_transferred bigint DEFAULT 0,
  error text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_active_transfers_user_id ON active_transfers(user_id);
CREATE INDEX IF NOT EXISTS idx_active_transfers_status ON active_transfers(status);

ALTER TABLE active_transfers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own transfers"
  ON active_transfers FOR SELECT
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

-- User settings table
CREATE TABLE IF NOT EXISTS user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_concurrent_uploads int DEFAULT 6,
  max_concurrent_downloads int DEFAULT 6,
  thumbnail_cache_enabled boolean DEFAULT true,
  extra jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own settings"
  ON user_settings FOR SELECT
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

CREATE POLICY "Users can insert own settings"
  ON user_settings FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

CREATE POLICY "Users can update own settings"
  ON user_settings FOR UPDATE
  TO authenticated
  USING (user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()))
  WITH CHECK (user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid()));

-- Thumbnail cache table
CREATE TABLE IF NOT EXISTS thumbnail_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  thumbnail_base64 text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_thumbnail_cache_user_id ON thumbnail_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_thumbnail_cache_lookup ON thumbnail_cache(user_id, chat_id, message_id);

ALTER TABLE thumbnail_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own thumbnails"
  ON thumbnail_cache FOR SELECT
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

CREATE POLICY "Users can insert own thumbnails"
  ON thumbnail_cache FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );

CREATE POLICY "Users can delete own thumbnails"
  ON thumbnail_cache FOR DELETE
  TO authenticated
  USING (
    user_id IN (SELECT id FROM users WHERE supabase_uid = auth.uid())
  );
