CREATE TABLE IF NOT EXISTS `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`identity` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`device_id` text,
	`generation` integer,
	`sequence` integer,
	`hash` text NOT NULL,
	`mime` text,
	`object_key` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	`duration` real,
	`captured_at` integer NOT NULL,
	`stored_at` integer NOT NULL,
	`author_id` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`quarantined` integer DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`status` text NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `recorder` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`device_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`owner_id` text,
	`status` text DEFAULT 'idle' NOT NULL
);
CREATE TABLE IF NOT EXISTS `records` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`generation` integer NOT NULL,
	`owner_id` text NOT NULL,
	`consent` text NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_identity_unique ON evidence(identity);
