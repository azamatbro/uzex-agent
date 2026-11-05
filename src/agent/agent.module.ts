import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import {
  AgentService,
  DATABASE_SERVICE_TOKEN,
  RAG_SERVICE_TOKEN,
} from './agent.service';
import { DatabaseModule } from '../database/database.module';
import { DatabaseService } from '../database/database.service';
import { RagModule } from '../rag/rag.module';
import { RagService } from '../rag/rag.service';
import { LibraryModule } from '../library/library.module';
import { LibraryService } from '../library/library.service';

@Module({
  imports: [DatabaseModule, RagModule, LibraryModule],
  controllers: [AgentController],
  providers: [
    {
      provide: DATABASE_SERVICE_TOKEN,
      useExisting: DatabaseService,
    },
    {
      provide: RAG_SERVICE_TOKEN,
      useExisting: RagService,
    },
    {
      provide: AgentService,
      useFactory: (dbService: DatabaseService, ragService: RagService, library: LibraryService) =>
        new AgentService(dbService, ragService, library),
      inject: [DatabaseService, RagService, LibraryService],
    },
  ],
  exports: [AgentService],
})
export class AgentModule {}
