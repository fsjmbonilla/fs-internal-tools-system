CREATE TABLE `calls` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`channel_id` bigint unsigned,
	`room_name` varchar(100) NOT NULL,
	`started_by` bigint unsigned NOT NULL,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`ended_at` timestamp,
	CONSTRAINT `calls_id` PRIMARY KEY(`id`),
	CONSTRAINT `calls_room_name_unique` UNIQUE(`room_name`)
);
--> statement-breakpoint
ALTER TABLE `calls` ADD CONSTRAINT `calls_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `calls` ADD CONSTRAINT `calls_started_by_users_id_fk` FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_calls_channel` ON `calls` (`channel_id`);