import pg from "pg";

// One shared connection pool for the whole app
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Minimal "migration": create the users table if it doesn't exist.
// (Later you can swap this for a real migration tool like Prisma/Drizzle/node-pg-migrate.)
export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email           TEXT NOT NULL,
      name            TEXT,
      avatar_url      TEXT,
      google_subject  TEXT UNIQUE NOT NULL,   -- Google's stable user id ("sub"), NOT the email
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// Create the user on first login, update profile on later logins.
// This single function is why "register" and "login" are the same flow.
export async function upsertUser(u: {
  subject: string; email: string; name?: string; avatarUrl?: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO users (google_subject, email, name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_subject)
     DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
                   avatar_url = EXCLUDED.avatar_url, updated_at = now()
     RETURNING id`,
    [u.subject, u.email, u.name ?? null, u.avatarUrl ?? null]
  );
  return rows[0].id as string;
}
