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
}

main().catch((err) => {
  console.error(`Startup failed: ${err.message}`);
  process.exit(1);
});
