import express from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { registerAuthHandler } from './auth/auth-handler.js';
import { loadEnv } from './config/env.js';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    instrument: ObserveInstrument,
  });
  app.enableCors({ origin: env.frontendUrl, credentials: true });

  const server = app.getHttpAdapter().getInstance();
  registerAuthHandler(server);
  app.use(express.json());

  await app.listen(env.port);
}
await bootstrap();
