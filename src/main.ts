import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { Database } from './db/database.js';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(ApiModule.forRoot(cfg), { bufferLogs: false });
  app.enableShutdownHooks();
  await app.get(Database).migrate();
  await app.listen(cfg.PORT);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
