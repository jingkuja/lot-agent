-- Lot Agent — PostgreSQL Schema Migration
-- Run: psql -d lot_agent -f migration.sql

BEGIN;

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. conversations
-- ============================================================
CREATE TABLE conversations (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    title       VARCHAR(500) NOT NULL DEFAULT 'New Chat',
    model       VARCHAR(100),
    provider    VARCHAR(50),
    system_prompt TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'active',
    metadata    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_conversations_status_updated
    ON conversations (status, updated_at DESC);

-- ============================================================
-- 2. messages
-- ============================================================
CREATE TABLE messages (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    content         TEXT        NOT NULL DEFAULT '',
    tool_call_id    VARCHAR(100),
    token_count     INTEGER,
    model           VARCHAR(100),
    latency_ms      INTEGER,
    status          VARCHAR(20) NOT NULL DEFAULT 'completed',
    metadata        JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);
CREATE INDEX idx_messages_role         ON messages (role);
CREATE INDEX idx_messages_tool_call_id ON messages (tool_call_id) WHERE tool_call_id IS NOT NULL;

-- ============================================================
-- 3. message_tool_calls
-- ============================================================
CREATE TABLE message_tool_calls (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID         NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    tool_call_id VARCHAR(100) NOT NULL,
    tool_name   VARCHAR(200) NOT NULL,
    tool_input  JSONB        NOT NULL DEFAULT '{}',
    status      VARCHAR(20)  NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_calls_message ON message_tool_calls (message_id);

-- ============================================================
-- 4. message_ratings
-- ============================================================
CREATE TABLE message_ratings (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE UNIQUE,
    rating      SMALLINT    NOT NULL CHECK (rating IN (1, -1)),
    feedback    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ratings_message ON message_ratings (message_id);
CREATE INDEX idx_ratings_rating  ON message_ratings (rating);

-- ============================================================
-- 5. traces
-- ============================================================
CREATE TABLE traces (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    model            VARCHAR(100),
    provider         VARCHAR(50),
    total_tokens     INTEGER     NOT NULL DEFAULT 0,
    total_latency_ms INTEGER,
    status           VARCHAR(20) NOT NULL DEFAULT 'ok',
    error_message    TEXT,
    metadata         JSONB       NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_traces_conversation ON traces (conversation_id, created_at DESC);

-- ============================================================
-- 6. spans
-- ============================================================
CREATE TABLE spans (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id        UUID        NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    parent_span_id  UUID        REFERENCES spans(id) ON DELETE SET NULL,
    name            VARCHAR(100) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'ok',
    attributes      JSONB       NOT NULL DEFAULT '{}',
    events          JSONB       NOT NULL DEFAULT '[]',
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ
);

CREATE INDEX idx_spans_trace ON spans (trace_id, start_time);
CREATE INDEX idx_spans_name  ON spans (name);

-- Auto-update conversations.updated_at on message insert
CREATE OR REPLACE FUNCTION update_conversation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_updated_at
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_conversation_timestamp();

COMMIT;
