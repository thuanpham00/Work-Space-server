-- Replace MUTED with CANCELED in member_status enum
-- PostgreSQL does not support DROP VALUE on enums, so we need to recreate the type.

-- Step 1: Rename current enum type
ALTER TYPE "member_status" RENAME TO "member_status_old";

-- Step 2: Create new enum with updated values
CREATE TYPE "member_status" AS ENUM (
  'active',
  'left',
  'banned',
  'pending_request',
  'pending_invite',
  'canceled'
);

-- Step 3: Drop the default on the column that references the old type
ALTER TABLE "channel_members" ALTER COLUMN "status" DROP DEFAULT;

-- Step 4: Convert column to text temporarily, cast to new enum, then add back default
ALTER TABLE "channel_members"
  ALTER COLUMN "status" TYPE "member_status" USING (
    CASE "status"::text
      WHEN 'muted' THEN 'canceled'
      ELSE "status"::text
    END
  )::"member_status";

ALTER TABLE "channel_members" ALTER COLUMN "status" SET DEFAULT 'active';

-- Step 5: Drop the old enum type
DROP TYPE "member_status_old";