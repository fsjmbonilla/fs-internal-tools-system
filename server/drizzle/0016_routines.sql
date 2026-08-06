CREATE TABLE `routine_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`routine_id` bigint unsigned NOT NULL,
	`status` enum('running','succeeded','failed','budget_exceeded') NOT NULL DEFAULT 'running',
	`trigger` enum('schedule','manual') NOT NULL DEFAULT 'schedule',
	`transcript` json,
	`summary` text,
	`input_tokens` int NOT NULL DEFAULT 0,
	`output_tokens` int NOT NULL DEFAULT 0,
	`iterations` int NOT NULL DEFAULT 0,
	`error` text,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`finished_at` timestamp,
	CONSTRAINT `routine_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(200) NOT NULL,
	`prompt` mediumtext NOT NULL,
	`schedule` varchar(120) NOT NULL,
	`scopes` json NOT NULL,
	`output_channel_id` bigint unsigned,
	`enabled` boolean NOT NULL DEFAULT true,
	`owner_id` bigint unsigned NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `routines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `routine_runs` ADD CONSTRAINT `routine_runs_routine_id_routines_id_fk` FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `routines` ADD CONSTRAINT `routines_output_channel_id_channels_id_fk` FOREIGN KEY (`output_channel_id`) REFERENCES `channels`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `routines` ADD CONSTRAINT `routines_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_routine_runs_routine` ON `routine_runs` (`routine_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_routines_enabled` ON `routines` (`enabled`);