import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('UZEX-NestJS');
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port);
  logger.log(`UZEX AI Analytics Web UI & API running at http://localhost:${port}`);
}

bootstrap();
