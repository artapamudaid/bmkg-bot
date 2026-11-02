import { Database } from 'bun:sqlite';

const db = new Database('data.sqlite');

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    city TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const upsertUserLocation = db.prepare(`
  INSERT INTO users (chat_id, city)
  VALUES ($chatId, $city)
  ON CONFLICT(chat_id) DO UPDATE SET
    city = excluded.city,
    updated_at = CURRENT_TIMESTAMP
`);

const selectUserLocation = db.prepare<{ city: string }, [number]>(`
  SELECT city
  FROM users
  WHERE chat_id = ?
`);

export const dbManager = {
  setUserLocation(chatId: number, city: string): void {
    upsertUserLocation.run({ $chatId: chatId, $city: city });
  },

  getUserLocation(chatId: number): string {
    return selectUserLocation.get(chatId)?.city ?? 'Kediri';
  },
};
