import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import * as path from 'path';
import { DatabaseModule } from './database/database.module';
import { RagModule } from './rag/rag.module';
import { AgentModule } from './agent/agent.module';
import { LibraryModule } from './library/library.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: path.join(process.cwd(), 'public'),
      exclude: ['/api/(.*)'],
    }),
    DatabaseModule,
    RagModule,
    AgentModule,
    LibraryModule,
  ],
})
export class AppModule {}
