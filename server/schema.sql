-- fs-internal-system messaging schema (MySQL/MariaDB, utf8mb4)
CREATE DATABASE IF NOT EXISTS fs_internal_system
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE fs_internal_system;

CREATE TABLE IF NOT EXISTS users (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(80) NOT NULL UNIQUE,
  is_private BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  joined_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (channel_id) REFERENCES channels (id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id),
  INDEX idx_channel_created (channel_id, created_at)
);

-- seed data for local development
INSERT IGNORE INTO users (id, email, display_name) VALUES
  (1, 'tech@flowerstore.ph', 'Tech');
INSERT IGNORE INTO channels (id, name) VALUES
  (1, 'general');
INSERT IGNORE INTO channel_members (channel_id, user_id) VALUES (1, 1);
