-- Add PENDING_REQUEST and PENDING_INVITE to member_status enum
ALTER TYPE "member_status" ADD VALUE IF NOT EXISTS 'pending_request';
ALTER TYPE "member_status" ADD VALUE IF NOT EXISTS 'pending_invite';
