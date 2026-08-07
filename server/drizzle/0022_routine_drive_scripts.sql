ALTER TABLE `routine_runs` ADD `script_run_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `routines` ADD `kind` enum('ai','drive_script') DEFAULT 'ai' NOT NULL;--> statement-breakpoint
ALTER TABLE `routines` ADD `drive_file_id` varchar(120);--> statement-breakpoint
ALTER TABLE `routines` ADD `drive_file_name` varchar(300);--> statement-breakpoint
ALTER TABLE `routines` ADD `script_scopes` json;--> statement-breakpoint
ALTER TABLE `routines` ADD `managed_script_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `routine_runs` ADD CONSTRAINT `routine_runs_script_run_id_script_runs_id_fk` FOREIGN KEY (`script_run_id`) REFERENCES `script_runs`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `routines` ADD CONSTRAINT `routines_managed_script_id_scripts_id_fk` FOREIGN KEY (`managed_script_id`) REFERENCES `scripts`(`id`) ON DELETE set null ON UPDATE no action;