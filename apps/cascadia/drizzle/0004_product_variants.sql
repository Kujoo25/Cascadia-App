CREATE TABLE "part_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"code" varchar(100) NOT NULL,
	"name" varchar(500) NOT NULL,
	"description" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL,
	CONSTRAINT "uq_part_families_design_code" UNIQUE("design_id","code"),
	CONSTRAINT "ck_part_families_code" CHECK ("part_families"."code" ~ '^[A-Z0-9][A-Z0-9-]*$')
);
--> statement-breakpoint
CREATE TABLE "part_variant_execution_bom_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"target_item_id" uuid NOT NULL,
	"quantity" numeric(10, 3) DEFAULT '1' NOT NULL,
	"reference_designator" text,
	"find_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL,
	CONSTRAINT "uq_variant_execution_bom_target" UNIQUE("execution_id","target_item_id")
);
--> statement-breakpoint
CREATE TABLE "part_variant_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_master_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"part_item_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(500),
	"sku" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL,
	CONSTRAINT "uq_variant_executions_item_code" UNIQUE("part_item_id","code"),
	CONSTRAINT "uq_variant_executions_item_master" UNIQUE("part_item_id","execution_master_id"),
	CONSTRAINT "ck_part_variant_executions_code" CHECK ("part_variant_executions"."code" ~ '^MK[A-Z0-9-]+$')
);
--> statement-breakpoint
CREATE TABLE "part_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"part_master_id" uuid NOT NULL,
	"code" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "part_variants_part_master_id_unique" UNIQUE("part_master_id"),
	CONSTRAINT "uq_part_variants_family_code" UNIQUE("family_id","code"),
	CONSTRAINT "ck_part_variants_code" CHECK ("part_variants"."code" ~ '^V[A-Z0-9-]+$')
);
--> statement-breakpoint
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_families" ADD CONSTRAINT "part_families_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_execution_bom_lines" ADD CONSTRAINT "part_variant_execution_bom_lines_execution_id_part_variant_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."part_variant_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_execution_bom_lines" ADD CONSTRAINT "part_variant_execution_bom_lines_target_item_id_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_execution_bom_lines" ADD CONSTRAINT "part_variant_execution_bom_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_execution_bom_lines" ADD CONSTRAINT "part_variant_execution_bom_lines_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_executions" ADD CONSTRAINT "part_variant_executions_variant_id_part_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."part_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_executions" ADD CONSTRAINT "part_variant_executions_part_item_id_items_id_fk" FOREIGN KEY ("part_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_executions" ADD CONSTRAINT "part_variant_executions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variant_executions" ADD CONSTRAINT "part_variant_executions_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variants" ADD CONSTRAINT "part_variants_family_id_part_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."part_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_variants" ADD CONSTRAINT "part_variants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_part_families_design" ON "part_families" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_variant_execution_bom_execution" ON "part_variant_execution_bom_lines" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_variant_execution_bom_target" ON "part_variant_execution_bom_lines" USING btree ("target_item_id");--> statement-breakpoint
CREATE INDEX "idx_variant_executions_variant" ON "part_variant_executions" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "idx_variant_executions_part_item" ON "part_variant_executions" USING btree ("part_item_id");--> statement-breakpoint
CREATE INDEX "idx_variant_executions_master" ON "part_variant_executions" USING btree ("execution_master_id");--> statement-breakpoint
CREATE INDEX "idx_part_variants_family" ON "part_variants" USING btree ("family_id");