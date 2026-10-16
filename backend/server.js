import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createBoothApp } from './app.js';

dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });

try {
  const { app, config } = await createBoothApp();
  app.listen(config.port, config.host, () => {
    console.log(`DEVFEST booth API running at http://${config.host}:${config.port}`);
    console.log(`Amazon Translate region: ${config.region}; offline mode: ${config.offlineMode}`);
  });
} catch (error) {
  console.error('The DEVFEST booth API could not start:', error.message);
  process.exitCode = 1;
}
