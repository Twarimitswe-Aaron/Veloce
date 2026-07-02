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
	/** Direct CDN/media URL when user picked a format (optional). */
	directUrl: text('direct_url'),
	/** Browser page referer required by signed CDN links. */
	referer: text('referer'),
	fileName: text('file_name').notNull(),
	savePath: text('save_path').notNull(),
	status: text('status', { enum: ['queued', 'downloading', 'paused', 'completed', 'error'] })
		.notNull()
		.default('queued'),
	totalBytes: integer('total_bytes'),
	downloadedBytes: integer('downloaded_bytes').default(0)
});

/** One row = entire playlist job (sequential tracks, single pause control). */
export const playlistJobs = sqliteTable('playlist_jobs', {
	id: text('id').primaryKey(),
	deviceId: text('device_id').notNull().references(() => devices.id),
	playlistUrl: text('playlist_url').notNull(),
	title: text('title').notNull(),
	saveDir: text('save_dir').notNull(),
	status: text('status', {
		enum: ['queued', 'downloading', 'paused', 'completed', 'error', 'cancelled']
	}).notNull().default('queued'),
	currentIndex: integer('current_index').notNull().default(0),
	totalTracks: integer('total_tracks').notNull(),
	completedTracks: integer('completed_tracks').notNull().default(0),
	failedTracks: integer('failed_tracks').notNull().default(0),
	entries: text('entries', { mode: 'json' }).notNull(),
	settings: text('settings', { mode: 'json' }),
	referer: text('referer'),
	threads: integer('threads').notNull().default(8),
	currentTrackTitle: text('current_track_title'),
	error: text('error'),
	failedIndices: text('failed_indices', { mode: 'json' }).$type<number[]>().default([]),
	downloadedBytes: integer('downloaded_bytes').default(0),
	totalBytes: integer('total_bytes').default(0),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
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
