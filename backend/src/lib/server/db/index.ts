import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema';
import path from 'path';

const dbPath = path.resolve(process.cwd(), 'veloce.db');
const client = createClient({ url: `file:${dbPath}` });

export const db = drizzle(client, { schema });
