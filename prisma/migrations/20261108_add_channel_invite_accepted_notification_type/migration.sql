-- Add "channel_invite_accepted" value to "notification_type" enum
-- Postgres: ADD VALUE không dùng được trong cùng transaction với việc sử dụng giá trị mới,
-- nên migration này chỉ gồm 1 statement.
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'channel_invite_accepted';
