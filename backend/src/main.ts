import express from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { registerAuthHandler } from './auth/auth-handler.js';
import { loadEnv } from './config/env.js';

function isAllowedFrontendOrigin(origin: string, configuredOrigin: string): boolean {
  if (origin === configuredOrigin || origin === 'https://rohit-schedula.vercel.app') return true;

  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    const hostname = url.hostname;
    return (
      hostname === 'rohit-schedula.vercel.app' ||
      /^rohit-schedula(?:-[a-z0-9-]+)?\.vercel\.app$/.test(hostname) ||
      /^rohit-schedula-(?:git-[a-z0-9-]+-)?[a-z0-9-]+-rohit-buwalas-projects\.vercel\.app$/.test(hostname)
    );
  } catch {
    return false;
  }
}

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    instrument: ObserveInstrument,
  });
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || isAllowedFrontendOrigin(origin, env.frontendUrl)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed by CORS'));
      }
    },
    credentials: true,
  });

  const server = app.getHttpAdapter().getInstance();
  registerAuthHandler(server);
  app.use(express.json());

  await app.listen(env.port, '0.0.0.0');
}
await bootstrap();
