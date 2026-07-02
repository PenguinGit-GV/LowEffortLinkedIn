require('dotenv').config();

const { loadConfig } = require('./config');
const { createDb } = require('./db/knex');
const { createServer } = require('./server');

async function main() {
  const config = loadConfig();
  const db = createDb(config);
  const { app } = createServer(config, db);

  await app.start(config.port);
  console.log(
    `⚡ LowEffortLinkedIn listening on :${config.port}` +
      ` (env: ${config.nodeEnv}, LinkedIn mock mode: ${config.linkedinMockMode})`
  );

  // Railway sends SIGTERM on redeploys; drain in-flight requests and release
  // the pool instead of dropping them mid-handler.
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    try {
      await app.stop();
      await db.destroy();
      process.exit(0);
    } catch (err) {
      console.error('Shutdown failed:', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
