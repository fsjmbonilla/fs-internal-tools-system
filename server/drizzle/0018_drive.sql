CREATE TABLE `project_drive_folders` (
	`project_id` bigint unsigned NOT NULL,
	`folder_id` varchar(120) NOT NULL,
	`folder_name` varchar(300) NOT NULL,
	`connected_by` bigint unsigned NOT NULL,
	`connected_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `project_drive_folders_project_id` PRIMARY KEY(`project_id`)
);
--> statement-breakpoint
ALTER TABLE `attachments` MODIFY COLUMN `storage_key` varchar(500);--> statement-breakpoint
ALTER TABLE `attachments` ADD `provider` enum('internal','gdrive') DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE `attachments` ADD `drive_file_id` varchar(120);--> statement-breakpoint
ALTER TABLE `attachments` ADD `web_view_link` varchar(500);--> statement-breakpoint
ALTER TABLE `attachments` ADD `icon_mime` varchar(120);--> statement-breakpoint
ALTER TABLE `project_drive_folders` ADD CONSTRAINT `project_drive_folders_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_drive_folders` ADD CONSTRAINT `project_drive_folders_connected_by_users_id_fk` FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `chk_attachments_provider_shape` CHECK ((`attachments`.`provider` = 'internal' AND `attachments`.`storage_key` IS NOT NULL AND `attachments`.`drive_file_id` IS NULL)
     OR (`attachments`.`provider` = 'gdrive' AND `attachments`.`storage_key` IS NULL AND `attachments`.`drive_file_id` IS NOT NULL));