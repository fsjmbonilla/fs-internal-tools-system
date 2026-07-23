-- Custom SQL migration file, put your code below! --
ALTER TABLE `notes` ADD FULLTEXT INDEX `idx_notes_fts` (`title`, `content`);
