require('dotenv').config();

// Railway's internal DATABASE_URL needs no SSL; if you point at a managed
// Postgres that requires it, append ?sslmode=require to the URL.
module.exports = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 10 },
  migrations: { directory: './src/db/migrations' },
};
