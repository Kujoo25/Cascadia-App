-- Three migrations that had not shipped in a tagged release - ai_chat_dialogs,
-- verification_integrity and system_elements - re-minted as one after
-- 0010_file_variant_applicability (Cascadia-App#118) took index 10. The
-- statements are the originals, unchanged and in their original order; only
-- the snapshot was regenerated, so the chain continues from 0010.
CREATE TABLE "ai_chat_dialogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_name" varchar(100) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"title" varchar(200) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_chat_dialogs" ADD CONSTRAINT "ai_chat_dialogs_session_id_ai_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_dialogs" ADD CONSTRAINT "ai_chat_dialogs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_chat_dialogs_session_id_idx" ON "ai_chat_dialogs" USING btree ("session_id");
--> statement-breakpoint
-- Verification integrity (systems-engineering Phase 2).
--
-- Consolidated from three generated steps — the additive columns, the drop of
-- requirements.allocated_design_id, and the drop of test_cases.test_plan_id —
-- so this wave ships one migration; the data statements between them are
-- written by hand and each is guarded, so a database that already carries
-- their effect re-runs them to no effect.
--
-- What changes:
--   * requirements.verification_status is derived from now on (the rollup of
--     the latest execution of every test case that verifies the requirement,
--     services/verification-rollup.ts), so every row is recomputed below, and
--     requirements.verification_waiver records the one manual exception. A
--     row waived by hand before waivers were recorded keeps its waiver, with a
--     note saying so.
--   * requirements.allocated_design_id is gone: allocation is the ALLOCATED_TO
--     edge, which is what coverage already counted; the column was written at
--     create and read by nothing.
--   * test_cases.test_plan_id (one version row) becomes
--     test_cases.test_plan_master_id (items.master_id of the plan), the
--     lineage reference physical_parts.part_master_id already uses, so plan
--     membership survives a revision and a clone can re-point it.
--   * The default TestCase lifecycle collapses to Draft / Active / Obsolete.
--     Execution results live in test_cases.execution_status and the history
--     table only; a test case sitting in Not Run / Passed / Failed / Blocked
--     moves to Active, and a result recorded only as a state survives as the
--     execution status. Upgrades never re-seed, so the definition row is
--     rewritten here under the version guard the seed applies — a definition
--     an admin has edited past it is left alone, and its items with it.
ALTER TABLE "requirements" ADD COLUMN "verification_waiver" jsonb;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "test_plan_master_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_test_case_plan_master" ON "test_cases" USING btree ("test_plan_master_id");--> statement-breakpoint
-- The master behind the version row each test case pointed at.
UPDATE "test_cases" tc SET "test_plan_master_id" = i."master_id" FROM "items" i WHERE i."id" = tc."test_plan_id" AND tc."test_plan_master_id" IS NULL;--> statement-breakpoint
ALTER TABLE "test_cases" DROP CONSTRAINT "test_cases_test_plan_id_items_id_fk";
--> statement-breakpoint
DROP INDEX "idx_test_case_plan";--> statement-breakpoint
ALTER TABLE "test_cases" DROP COLUMN "test_plan_id";--> statement-breakpoint
ALTER TABLE "requirements" DROP CONSTRAINT "requirements_allocated_design_id_designs_id_fk";
--> statement-breakpoint
DROP INDEX "idx_req_allocated";--> statement-breakpoint
ALTER TABLE "requirements" DROP COLUMN "allocated_design_id";--> statement-breakpoint
-- The default TestCase lifecycle, v4, with the seed's layout. Guarded on the
-- version the way seedDefaultLifecycles is, and the item moves ride on the
-- rewrite having happened: a database whose definition is already past v4
-- keeps its states.
DO $$
DECLARE rewritten integer;
BEGIN
  UPDATE "workflow_definitions"
    SET "definition" = $json${"states":[{"id":"Draft","name":"Draft","color":"gray","isInitial":true,"isFinal":false,"position":{"x":30,"y":20}},{"id":"Active","name":"Active","color":"green","isInitial":false,"isFinal":false,"position":{"x":100,"y":220}},{"id":"Obsolete","name":"Obsolete","color":"red","isInitial":false,"isFinal":true,"position":{"x":20,"y":420}}],"transitions":[{"id":"tc-t1","name":"Activate","fromStateId":"Draft","toStateId":"Active"},{"id":"tc-t2","name":"Return to Draft","fromStateId":"Active","toStateId":"Draft"},{"id":"tc-t3","name":"Obsolete","fromStateId":"Draft","toStateId":"Obsolete"},{"id":"tc-t4","name":"Obsolete","fromStateId":"Active","toStateId":"Obsolete"}],"lifecycleType":"Free","applicableItemTypes":["TestCase"]}$json$::jsonb, "version" = 4
    WHERE "id" = '00000000-0000-4000-8000-000000000108' AND "version" < 4;
  GET DIAGNOSTICS rewritten = ROW_COUNT;
  IF rewritten > 0 THEN
    UPDATE "test_cases" tc SET "execution_status" = i."state"
      FROM "items" i
      WHERE i."id" = tc."item_id" AND i."item_type" = 'TestCase'
        AND i."state" IN ('Passed', 'Failed', 'Blocked') AND tc."execution_status" IS NULL;
    UPDATE "items" SET "state" = 'Active'
      WHERE "item_type" = 'TestCase' AND "state" IN ('NotRun', 'Passed', 'Failed', 'Blocked');
  END IF;
END $$;--> statement-breakpoint
-- A waiver set by hand before waivers were recorded keeps its effect.
UPDATE "requirements" SET "verification_waiver" = jsonb_build_object('note', 'Waived before verification status was derived', 'waivedBy', NULL, 'waivedAt', to_jsonb(now())) WHERE "verification_status" = 'Waived' AND "verification_waiver" IS NULL;--> statement-breakpoint
-- Every other row takes the derived status: any verifying test whose latest
-- execution failed -> Failed; every verifying test passed (at least one) ->
-- Passed; any execution at all -> InProgress; else NotStarted. Edges that
-- name an earlier revision of the requirement count, as the readers' lineage
-- walk counts them; a test case that was never run is not a pass.
UPDATE "requirements" r SET "verification_status" = d."status"
FROM (
  SELECT req."item_id",
    CASE
      WHEN bool_or(tc."execution_status" = 'Failed') THEN 'Failed'
      WHEN count(tc."item_id") > 0 AND bool_and(coalesce(tc."execution_status", '') = 'Passed') FILTER (WHERE tc."item_id" IS NOT NULL) THEN 'Passed'
      WHEN bool_or(tc."execution_status" IN ('Passed', 'Failed', 'Blocked')) THEN 'InProgress'
      ELSE 'NotStarted'
    END AS "status"
  FROM "requirements" req
  JOIN "items" ri ON ri."id" = req."item_id"
  LEFT JOIN "items" rrows ON rrows."master_id" = ri."master_id"
  LEFT JOIN "item_relationships" ir ON ir."target_id" = rrows."id" AND ir."relationship_type" = 'VERIFIED_BY'
  LEFT JOIN "items" src ON src."id" = ir."source_id" AND src."is_current" = true AND src."is_deleted" = false AND src."item_type" = 'TestCase'
  LEFT JOIN "test_cases" tc ON tc."item_id" = src."id"
  GROUP BY req."item_id"
) d
WHERE r."item_id" = d."item_id" AND r."verification_status" IS DISTINCT FROM 'Waived' AND r."verification_status" IS DISTINCT FROM d."status";
--> statement-breakpoint
-- System elements (systems-engineering Phase 5).
--
-- The `system_elements` table is the SystemElement item type's own row, one
-- per item version like every type-specific table; the architecture tree
-- (DECOMPOSES) and the hop to the physical item (REALIZED_BY) are edges in
-- item_relationships and need no columns here.
--
-- The default SystemElement lifecycle — the Part definition scoped to the
-- type, with the seed's layout — and its item-type link land below. Upgrades
-- never re-seed, so a migration is where an existing database gets them;
-- both statements are guarded, so a fresh install the seed already wrote
-- re-runs them to no effect. The link records who wrote it, so it is written
-- only where the seed's system user exists; without it the registry falls
-- back to the definition id the code carries for the type.

CREATE TABLE "system_elements" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"element_kind" varchar(20),
	"description" text
);
--> statement-breakpoint
ALTER TABLE "system_elements" ADD CONSTRAINT "system_elements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_system_elements_kind" ON "system_elements" USING btree ("element_kind");--> statement-breakpoint
INSERT INTO "workflow_definitions" ("id", "name", "version", "workflow_type", "definition", "is_active", "lifecycle_type", "drivers")
VALUES ('00000000-0000-4000-8000-000000000115', 'System Element - Default Lifecycle', 1, 'strict', $json${"states":[{"id":"Draft","name":"Draft","description":"Item is being created or edited","color":"gray","isInitial":true,"isFinal":false,"position":{"x":170,"y":20}},{"id":"Released","name":"Released","description":"Item is released for use","color":"green","isInitial":false,"isFinal":false,"position":{"x":170,"y":220}},{"id":"Superseded","name":"Superseded","description":"Replaced by a newer revision","color":"slate","isInitial":false,"isFinal":true,"position":{"x":20,"y":420}},{"id":"Obsolete","name":"Obsolete","description":"Item is no longer used","color":"red","isInitial":false,"isFinal":true,"position":{"x":320,"y":420}}],"transitions":[],"changeActionMappings":{"release":{"fromState":"Draft","toState":"Released","assignsRevision":true},"revise":{"fromState":"Released","newVersionState":"Released","oldVersionState":"Superseded","assignsRevision":true},"obsolete":{"fromState":"Released","toState":"Obsolete","assignsRevision":false}},"lifecycleType":"Driven","description":"System element lifecycle. Release, revision and obsolescence go through ECOs, as for Parts.","applicableItemTypes":["SystemElement"]}$json$::jsonb, true, 'Driven', '[]'::jsonb)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "item_type_configs" ("item_type", "config", "modified_by")
SELECT 'SystemElement', '{"lifecycleDefinitionId":"00000000-0000-4000-8000-000000000115"}'::jsonb, u."id"
FROM "users" u WHERE u."id" = '00000000-0000-4000-8000-000000000000'
ON CONFLICT ("item_type") DO NOTHING;--> statement-breakpoint
-- The seeded roles hold the new resource the way they hold `requirements`:
-- the architecture is reachable by whoever can reach the requirements that
-- land on it. Code's ROLE_DEFINITIONS say the same for the five shipped
-- roles; a custom role gets the same rule, and a role that already names
-- `system_elements` (an administrator who got there first) is left alone.
UPDATE "roles" SET "permissions" = "permissions" || jsonb_build_object('system_elements', "permissions"->'requirements') WHERE "permissions" ? 'requirements' AND NOT ("permissions" ? 'system_elements');
