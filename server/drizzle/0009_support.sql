CREATE TABLE `support_configs` (
	`channel_id` bigint unsigned NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`intake_column_id` bigint unsigned NOT NULL,
	`ai_enabled` boolean NOT NULL DEFAULT true,
	`instructions` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `support_configs_channel_id` PRIMARY KEY(`channel_id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `is_bot` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `kind` enum('standard','support') DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `origin_channel_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `tasks` ADD `origin_message_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source` enum('manual','support') DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` enum('low','medium','high','urgent');--> statement-breakpoint
ALTER TABLE `support_configs` ADD CONSTRAINT `support_configs_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_configs` ADD CONSTRAINT `support_configs_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `support_configs` ADD CONSTRAINT `support_configs_intake_column_id_task_columns_id_fk` FOREIGN KEY (`intake_column_id`) REFERENCES `task_columns`(`id`) ON DELETE cascade ON UPDATE no action;