'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
}

const { app, db, logger } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  logger.info(`Voyagr running on http://${config.host}:${config.port} (${config.env})`);
});

// Defend against slow-loris style connections.
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => logger.error(`Unhandled rejection: ${err?.message ?? err}`));
