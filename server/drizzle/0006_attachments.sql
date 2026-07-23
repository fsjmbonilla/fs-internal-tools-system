CREATE TABLE `attachments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`uploader_id` bigint unsigned NOT NULL,
	`message_id` bigint unsigned,
	`task_id` bigint unsigned,
	`doc_id` bigint unsigned,
	`storage_key` varchar(500) NOT NULL,
	`file_name` varchar(255) NOT NULL,
	`mime_type` varchar(120) NOT NULL,
	`size_bytes` int unsigned NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_uploader_id_users_id_fk` FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_doc_id_docs_id_fk` FOREIGN KEY (`doc_id`) REFERENCES `docs`(`id`) ON DELETE cascade ON UPDATE no action;