-- Portal hosts come from env only; drop the hard-coded staging host default.
-- Every insert sets host explicitly (see upsert* in src/lib/streamline-import.ts).
ALTER TABLE "mbu_logs" ALTER COLUMN "host" DROP DEFAULT;
ALTER TABLE "server_side_rules_log" ALTER COLUMN "host" DROP DEFAULT;
ALTER TABLE "traces" ALTER COLUMN "host" DROP DEFAULT;
