import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule, configureApp } from './app.module';
import { loadConfig } from './config/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  configureApp(app);
  await app.listen(config.PORT);
}

void bootstrap();
