import { Global, Module } from '@nestjs/common';
import { RagService } from './rag.service';
import { DatabaseModule } from '../database/database.module';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
