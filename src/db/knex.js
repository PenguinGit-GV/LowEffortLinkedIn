const knex = require('knex');
const knexfile = require('../../knexfile');

function createDb(config) {
  return knex({ ...knexfile, connection: config.databaseUrl });
}

module.exports = { createDb };
