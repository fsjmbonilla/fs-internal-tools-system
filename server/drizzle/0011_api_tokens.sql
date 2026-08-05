CREATE TABLE `api_tokens` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`scopes` json NOT NULL,
	`acts_as_user_id` bigint unsigned NOT NULL,
	`created_by` bigint unsigned NOT NULL,
	`last_used_at` timestamp,
	`expires_at` timestamp,
	`revoked_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `api_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `api_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_acts_as_user_id_users_id_fk` FOREIGN KEY (`acts_as_user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD CONSTRAINT `api_tokens_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;