CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('superadmin', 'tenant')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',
  PRIMARY KEY (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS cells (
  id text PRIMARY KEY,
  tenant_id text UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  worker_id text NOT NULL DEFAULT 'mac-local',
  runtime_name text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'missing',
  desired_vcpus integer NOT NULL DEFAULT 2,
  max_vcpus integer NOT NULL DEFAULT 4,
  desired_memory_mib integer NOT NULL DEFAULT 4096,
  max_memory_mib integer NOT NULL DEFAULT 16384,
  agents_status text NOT NULL DEFAULT 'pending',
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cells ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'tenant';
DO $$ BEGIN
  ALTER TABLE cells ADD CONSTRAINT cells_kind_check CHECK (kind IN ('tenant','master'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS workers (
  id text PRIMARY KEY,
  platform text,
  runtime text,
  status text NOT NULL DEFAULT 'offline',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Reserved for the post-MVP inter-session wake/push subsystem. No delivery API
-- is exposed yet, but stable UUIDs and idempotent messages are part of the schema.
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_uuid uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cell_id text NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  harness text NOT NULL CHECK (harness IN ('codex', 'claude')),
  native_session_id text,
  status text NOT NULL DEFAULT 'unknown',
  wake_capability boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Untitled session';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS cwd text NOT NULL DEFAULT '/workspace';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS effort text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS created_by text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS telemetry jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS alias text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS goal jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
UPDATE agent_sessions SET alias='session-' || substr(session_uuid::text,1,8) WHERE alias IS NULL OR btrim(alias)='';
UPDATE agent_sessions SET title=alias WHERE title='new-agent' AND alias<>'new-agent';
ALTER TABLE agent_sessions ALTER COLUMN alias SET NOT NULL;
UPDATE agent_sessions SET wake_capability=true;

CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_namespaced_alias_idx
  ON agent_sessions(tenant_id,harness,model,cwd,lower(alias));

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY,
  session_uuid uuid NOT NULL REFERENCES agent_sessions(session_uuid) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
  ON chat_messages(session_uuid, created_at);

CREATE TABLE IF NOT EXISTS provider_usage_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cell_id text NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  harness text NOT NULL CHECK (harness IN ('codex', 'claude')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_usage_snapshots_latest_idx
  ON provider_usage_snapshots(cell_id,harness,captured_at DESC);

CREATE TABLE IF NOT EXISTS session_messages (
  id uuid PRIMARY KEY,
  source_session_uuid uuid REFERENCES agent_sessions(session_uuid) ON DELETE SET NULL,
  target_session_uuid uuid NOT NULL REFERENCES agent_sessions(session_uuid) ON DELETE CASCADE,
  idempotency_key text UNIQUE NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'backlog_only',
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

ALTER TABLE session_messages ALTER COLUMN status SET DEFAULT 'queued';
UPDATE session_messages SET status='queued' WHERE status='backlog_only';
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS channel_id uuid;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days');
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 100;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS result jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS created_by text REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS inter_session_message_id uuid REFERENCES session_messages(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_inter_session_role_idx
  ON chat_messages(inter_session_message_id,role) WHERE inter_session_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS session_messages_delivery_idx
  ON session_messages(status,available_at,created_at);
CREATE INDEX IF NOT EXISTS session_messages_target_order_idx
  ON session_messages(target_session_uuid,created_at);

CREATE TABLE IF NOT EXISTS session_channels (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_channel_members (
  channel_id uuid NOT NULL REFERENCES session_channels(id) ON DELETE CASCADE,
  session_uuid uuid NOT NULL REFERENCES agent_sessions(session_uuid) ON DELETE CASCADE,
  permission text NOT NULL DEFAULT 'both' CHECK (permission IN ('send','receive','both')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(channel_id,session_uuid)
);

DO $$ BEGIN
  ALTER TABLE session_messages ADD CONSTRAINT session_messages_channel_fk
    FOREIGN KEY (channel_id) REFERENCES session_channels(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS session_message_events (
  id bigserial PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES session_messages(id) ON DELETE CASCADE,
  state text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_message_events_message_idx
  ON session_message_events(message_id,created_at);

CREATE TABLE IF NOT EXISTS port_routes (
  id uuid PRIMARY KEY,
  cell_id text NOT NULL REFERENCES cells(id) ON DELETE CASCADE,
  requested_by text REFERENCES users(id) ON DELETE SET NULL,
  guest_port integer NOT NULL CHECK (guest_port BETWEEN 1 AND 65535),
  host_port integer NOT NULL CHECK (host_port BETWEEN 1 AND 65535),
  bind_address text NOT NULL DEFAULT '127.0.0.1' CHECK (bind_address IN ('127.0.0.1','0.0.0.0')),
  protocol text NOT NULL DEFAULT 'tcp' CHECK (protocol='tcp'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','active','revoked','error')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP INDEX IF EXISTS port_routes_active_host_idx;
CREATE UNIQUE INDEX port_routes_active_host_idx
  ON port_routes(host_port) WHERE status IN ('requested','active');
