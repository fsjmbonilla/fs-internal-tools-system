ALTER TABLE `notes` MODIFY COLUMN `content` mediumtext NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `format` enum('markdown','rich') DEFAULT 'markdown' NOT NULL;