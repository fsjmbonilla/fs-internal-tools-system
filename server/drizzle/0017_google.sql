CREATE TABLE `gmail_ingest_state` (
	`google_account_id` bigint unsigned NOT NULL,
	`last_internal_date` bigint NOT NULL DEFAULT 0,
	`target_channel_id` bigint unsigned NOT NULL,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `gmail_ingest_state_google_account_id` PRIMARY KEY(`google_account_id`)
);
--> statement-breakpoint
CREATE TABLE `google_accounts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned,
	`kind` enum('user','support_mailbox') NOT NULL,
	`google_email` varchar(320) NOT NULL,
	`refresh_token_enc` varbinary(1024) NOT NULL,
	`scopes` json NOT NULL,
	`status` enum('active','broken') NOT NULL DEFAULT 'active',
	`connected_by` bigint unsigned NOT NULL,
	`connected_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `google_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_google_accounts_user_kind` UNIQUE(`user_id`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `message_email_origins` (
	`message_id` bigint unsigned NOT NULL,
	`gmail_message_id` varchar(32) NOT NULL,
	`from_addr` varchar(320) NOT NULL,
	`subject` varchar(500) NOT NULL DEFAULT '',
	CONSTRAINT `message_email_origins_message_id` PRIMARY KEY(`message_id`),
	CONSTRAINT `uq_message_email_origins_gmail_id` UNIQUE(`gmail_message_id`)
);
--> statement-breakpoint
ALTER TABLE `gmail_ingest_state` ADD CONSTRAINT `gmail_ingest_state_google_account_id_google_accounts_id_fk` FOREIGN KEY (`google_account_id`) REFERENCES `google_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gmail_ingest_state` ADD CONSTRAINT `gmail_ingest_state_target_channel_id_channels_id_fk` FOREIGN KEY (`target_channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `google_accounts` ADD CONSTRAINT `google_accounts_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `google_accounts` ADD CONSTRAINT `google_accounts_connected_by_users_id_fk` FOREIGN KEY (`connected_by`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_email_origins` ADD CONSTRAINT `message_email_origins_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;