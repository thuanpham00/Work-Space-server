-- Add CHANNEL_REQUEST_SENT to notification_type enum
ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'channel_request_sent';
