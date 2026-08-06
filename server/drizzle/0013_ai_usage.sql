CREATE TABLE `ai_usage` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`channel_id` bigint unsigned NOT NULL,
	`provider` varchar(32) NOT NULL,
	`model` varchar(100) NOT NULL,
	`prompt_tokens` int NOT NULL DEFAULT 0,
	`completion_tokens` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ai_usage_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `ai_usage` ADD CONSTRAINT `ai_usage_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_ai_usage_channel_created` ON `ai_usage` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_ai_usage_created` ON `ai_usage` (`created_at`);