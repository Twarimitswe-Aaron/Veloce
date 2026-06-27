import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const devices = sqliteTable('devices', {
	id: text('id').primaryKey(), // MAC Address
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
	lastActive: integer('last_active', { mode: 'timestamp' }).notNull(),
	settings: text('settings', { mode: 'json' }) // e.g., default paths
});

export const downloads = sqliteTable('downloads', {
	id: text('id').primaryKey(), // UUID string
	deviceId: text('device_id')
		.notNull()
		.references(() => devices.id),
	url: text('url').notNull(),
	fileName: text('file_name').notNull(),
	status: text('status', { enum: ['queued', 'downloading', 'paused', 'completed', 'error'] })
		.notNull()
		.default('queued'),
	totalBytes: integer('total_bytes'),
	downloadedBytes: integer('downloaded_bytes').default(0)
});

export const chunks = sqliteTable('chunks', {
	id: text('id').primaryKey(), // UUID string
	downloadId: text('download_id')
		.notNull()
		.references(() => downloads.id),
	chunkIndex: integer('chunk_index').notNull(),
	startByte: integer('start_byte').notNull(),
	endByte: integer('end_byte').notNull(),
	status: text('status', { enum: ['pending', 'complete'] })
		.notNull()
		.default('pending')
});
