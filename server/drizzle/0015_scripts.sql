CREATE TABLE `script_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`script_id` bigint unsigned NOT NULL,
	`status` enum('queued','running','succeeded','failed','timeout') NOT NULL DEFAULT 'queued',
	`triggered_by` bigint unsigned NOT NULL,
	`token_id` bigint unsigned,
	`exit_code` int,
	`stdout` mediumtext,
	`stderr` mediumtext,
	`error` text,
	`started_at` timestamp,
	`finished_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `script_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` varchar(500),
	`language` enum('python') NOT NULL DEFAULT 'python',
	`source` mediumtext NOT NULL,
	`scopes` json NOT NULL,
	`created_by` bigint unsigned NOT NULL,
	`updated_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `scripts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `script_runs` ADD CONSTRAINT `script_runs_script_id_scripts_id_fk` FOREIGN KEY (`script_id`) REFERENCES `scripts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `script_runs` ADD CONSTRAINT `script_runs_triggered_by_users_id_fk` FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scripts` ADD CONSTRAINT `scripts_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `scripts` ADD CONSTRAINT `scripts_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_runs_script_created` ON `script_runs` (`script_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_status_id` ON `script_runs` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `idx_scripts_created_by` ON `scripts` (`created_by`);