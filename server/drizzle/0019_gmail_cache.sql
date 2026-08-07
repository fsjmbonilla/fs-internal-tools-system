CREATE TABLE `gmail_cache` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`google_account_id` bigint unsigned NOT NULL,
	`message_id` varchar(32) NOT NULL,
	`thread_id` varchar(32) NOT NULL,
	`from_addr` varchar(512) NOT NULL,
	`to_addr` varchar(1024) NOT NULL DEFAULT '',
	`subject` varchar(1024) NOT NULL DEFAULT '',
	`snippet` text NOT NULL,
	`internal_date` bigint unsigned NOT NULL,
	`unread` boolean NOT NULL DEFAULT false,
	`body_text` mediumtext,
	`body_html` mediumtext,
	`body_fetched_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gmail_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_gmail_cache_account_message` UNIQUE(`google_account_id`,`message_id`)
);
--> statement-breakpoint
CREATE TABLE `gmail_sync_state` (
	`google_account_id` bigint unsigned NOT NULL,
	`watermark` bigint unsigned NOT NULL DEFAULT 0,
	`last_sync_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `gmail_sync_state_google_account_id` PRIMARY KEY(`google_account_id`)
);
--> statement-breakpoint
ALTER TABLE `gmail_cache` ADD CONSTRAINT `gmail_cache_google_account_id_google_accounts_id_fk` FOREIGN KEY (`google_account_id`) REFERENCES `google_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gmail_sync_state` ADD CONSTRAINT `gmail_sync_state_google_account_id_google_accounts_id_fk` FOREIGN KEY (`google_account_id`) REFERENCES `google_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_gmail_cache_account_date` ON `gmail_cache` (`google_account_id`,`internal_date`);