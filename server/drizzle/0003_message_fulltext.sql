-- Custom SQL migration file, put your code below! --
ALTER TABLE `messages` ADD FULLTEXT INDEX `idx_messages_body_fts` (`body`);
