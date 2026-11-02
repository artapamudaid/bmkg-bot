import { Database } from 'bun:sqlite';

const db = new Database('data.sqlite');

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id INTEGER PRIMARY KEY,
    city TEXT NOT NULL,
    adm4_code TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const userColumns = db.query<{ name: string }, []>('PRAGMA table_info(users)').all();
if (!userColumns.some((column) => column.name === 'adm4_code')) {
  db.run('ALTER TABLE users ADD COLUMN adm4_code TEXT');
}

const upsertUserLocation = db.prepare(`
  INSERT INTO users (chat_id, city, adm4_code)
  VALUES ($chatId, $city, $adm4Code)
  ON CONFLICT(chat_id) DO UPDATE SET
    city = excluded.city,
    adm4_code = excluded.adm4_code,
    updated_at = CURRENT_TIMESTAMP
`);

const selectUserLocation = db.prepare<
  { city: string; adm4_code: string | null },
  [number]
>(`
  SELECT city, adm4_code
  FROM users
  WHERE chat_id = ?
`);

export const dbManager = {
  setUserLocation(chatId: number, city: string, adm4Code: string): void {
    upsertUserLocation.run({
      $chatId: chatId,
      $city: city,
      $adm4Code: adm4Code,
    });
  },

  getUserLocation(chatId: number): string {
    return this.getUserLocationDetails(chatId).city;
  },

  getUserLocationDetails(chatId: number): {
    city: string;
    adm4Code: string | null;
  } {
    const user = selectUserLocation.get(chatId);
    return {
      city: user?.city ?? 'Kediri',
      adm4Code: user?.adm4_code ?? null,
    };
  },
};
