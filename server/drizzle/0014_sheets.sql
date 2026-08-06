CREATE TABLE `sheets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`project_id` bigint unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`data` longtext NOT NULL,
	`created_by` bigint unsigned NOT NULL,
	`updated_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sheets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sheets` ADD CONSTRAINT `sheets_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sheets` ADD CONSTRAINT `sheets_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sheets` ADD CONSTRAINT `sheets_updated_by_users_id_fk` FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_sheets_project` ON `sheets` (`project_id`);