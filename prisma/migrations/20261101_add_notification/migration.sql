-- Create notification_type enum
CREATE TYPE "notification_type" AS ENUM (
  'channel_invited',
  'channel_invite_revoked',
  'channel_request_approved',
  'channel_request_rejected',
  'friend_request',
  'friend_request_accepted',
  'mention',
  'system'
);

-- Create notifications table
CREATE TABLE "notifications" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "type" "notification_type" NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT,
  "actor_id" BIGINT,
  "channel_id" BIGINT,
  "workspace_id" BIGINT,
  "metadata" JSONB,
  "is_read" BOOLEAN NOT NULL DEFAULT false,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
CREATE INDEX "notifications_user_id_type_idx" ON "notifications"("user_id", "type");
CREATE INDEX "notifications_is_read_created_at_idx" ON "notifications"("is_read", "created_at");
