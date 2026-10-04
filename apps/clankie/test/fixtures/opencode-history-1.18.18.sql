-- Native schema excerpts: https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/database/schema.gen.ts
-- Fixture only, never executed by reader.
-- MIT License
-- 
-- Copyright (c) 2025 opencode
-- 
-- Permission is hereby granted, free of charge, to any person obtaining a copy
-- of this software and associated documentation files (the "Software"), to deal
-- in the Software without restriction, including without limitation the rights
-- to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
-- copies of the Software, and to permit persons to whom the Software is
-- furnished to do so, subject to the following conditions:
-- 
-- The above copyright notice and this permission notice shall be included in all
-- copies or substantial portions of the Software.
-- 
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
-- IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
-- FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
-- AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
-- LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
-- OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
-- SOFTWARE.
CREATE TABLE `message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `part` (
          `id` text PRIMARY KEY,
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text NOT NULL,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_compacting` integer,
          `time_archived` integer,
          CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE TABLE migration(id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL);
INSERT INTO migration VALUES ('20260127222353_familiar_lady_ursula',1);
INSERT INTO migration VALUES ('20260211171708_add_project_commands',1);
INSERT INTO migration VALUES ('20260213144116_wakeful_the_professor',1);
INSERT INTO migration VALUES ('20260225215848_workspace',1);
INSERT INTO migration VALUES ('20260227213759_add_session_workspace_id',1);
INSERT INTO migration VALUES ('20260228203230_blue_harpoon',1);
INSERT INTO migration VALUES ('20260303231226_add_workspace_fields',1);
INSERT INTO migration VALUES ('20260309230000_move_org_to_state',1);
INSERT INTO migration VALUES ('20260312043431_session_message_cursor',1);
INSERT INTO migration VALUES ('20260323234822_events',1);
INSERT INTO migration VALUES ('20260410174513_workspace-name',1);
INSERT INTO migration VALUES ('20260413175956_chief_energizer',1);
INSERT INTO migration VALUES ('20260423070820_add_icon_url_override',1);
INSERT INTO migration VALUES ('20260427172553_slow_nightmare',1);
INSERT INTO migration VALUES ('20260428004200_add_session_path',1);
INSERT INTO migration VALUES ('20260501142318_next_venus',1);
INSERT INTO migration VALUES ('20260504145000_add_sync_owner',1);
INSERT INTO migration VALUES ('20260507164347_add_workspace_time',1);
INSERT INTO migration VALUES ('20260510033149_session_usage',1);
INSERT INTO migration VALUES ('20260511000411_data_migration_state',1);
INSERT INTO migration VALUES ('20260511173437_session-metadata',1);
INSERT INTO migration VALUES ('20260601010001_normalize_storage_paths',1);
INSERT INTO migration VALUES ('20260601202201_amazing_prowler',1);
INSERT INTO migration VALUES ('20260602002951_lowly_union_jack',1);
INSERT INTO migration VALUES ('20260602182828_add_project_directories',1);
INSERT INTO migration VALUES ('20260603001617_session_message_projection_indexes',1);
INSERT INTO migration VALUES ('20260603040000_session_message_projection_order',1);
INSERT INTO migration VALUES ('20260603141458_session_input_inbox',1);
INSERT INTO migration VALUES ('20260603160727_jittery_ezekiel_stane',1);
INSERT INTO migration VALUES ('20260604172448_event_sourced_session_input',1);
INSERT INTO migration VALUES ('20260605003541_add_session_context_snapshot',1);
INSERT INTO migration VALUES ('20260605042240_add_context_epoch_agent',1);
INSERT INTO migration VALUES ('20260611035744_credential',1);
INSERT INTO migration VALUES ('20260611192811_lush_chimera',1);
INSERT INTO migration VALUES ('20260612174303_project_dir_strategy',1);
INSERT INTO migration VALUES ('20260622142730_simplify_session_context_epoch',1);
INSERT INTO migration VALUES ('20260622170816_reset_v2_session_state',1);
INSERT INTO migration VALUES ('20260622202450_simplify_session_input',1);
