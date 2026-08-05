-- Runs once, on first start of the dev MySQL container (see
-- docker-compose.dev.yml). The image creates only the database named in
-- MYSQL_DATABASE, but `npm test` needs a separate one it can truncate freely.
CREATE DATABASE IF NOT EXISTS fs_internal_system_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON fs_internal_system_test.* TO 'fs_app'@'%';
GRANT ALL PRIVILEGES ON fs_internal_system.* TO 'fs_app'@'%';
FLUSH PRIVILEGES;
