CREATE TABLE `message_mentions` (
	`message_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	CONSTRAINT `message_mentions_message_id_user_id_pk` PRIMARY KEY(`message_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`message_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`emoji` varchar(32) NOT NULL,
	CONSTRAINT `message_reactions_message_id_user_id_emoji_pk` PRIMARY KEY(`message_id`,`user_id`,`emoji`)
);
--> statement-breakpoint
ALTER TABLE `channels` DROP INDEX `channels_name_unique`;--> statement-breakpoint
ALTER TABLE `channels` MODIFY COLUMN `name` varchar(80);--> statement-breakpoint
ALTER TABLE `channel_members` ADD `role` enum('owner','member') DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `channel_members` ADD `last_read_message_id` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `type` enum('public','private','dm') DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `channels` ADD `topic` varchar(255);--> statement-breakpoint
ALTER TABLE `channels` ADD `dm_key` varchar(50);--> statement-breakpoint
ALTER TABLE `channels` ADD `created_by` bigint unsigned;--> statement-breakpoint
ALTER TABLE `messages` ADD `edited_at` datetime;--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted_at` datetime;--> statement-breakpoint
ALTER TABLE `channels` ADD CONSTRAINT `channels_dm_key_unique` UNIQUE(`dm_key`);--> statement-breakpoint
ALTER TABLE `message_mentions` ADD CONSTRAINT `message_mentions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_mentions` ADD CONSTRAINT `message_mentions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_reactions` ADD CONSTRAINT `message_reactions_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_reactions` ADD CONSTRAINT `message_reactions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_mm_user` ON `message_mentions` (`user_id`);--> statement-breakpoint
ALTER TABLE `channels` ADD CONSTRAINT `channels_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_channel_id` ON `messages` (`channel_id`,`id`);