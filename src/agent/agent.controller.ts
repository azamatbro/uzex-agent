import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { AgentAskResponse, AgentService } from './agent.service';
import { DatabaseService } from '../database/database.service';
import {
  BenchmarkQuestion,
  BenchmarkSuiteReport,
  runBenchmarkSuite,
  UZEX_BENCHMARK_QUESTIONS,
} from './benchmark';

export class AskAgentDto {
  sessionId?: string;
  message!: string;
  model?: string;
  language?: string;
  provider?: 'openai' | 'gemini' | 'claude' | 'deepseek';
  apiKey?: string;
}

export class RunBenchmarkDto {
  questionId?: string;
  benchmarkId?: string;
  runAll?: boolean;
  model?: string;
}

@Controller('api')
export class AgentController {
  constructor(
    private readonly agentService: AgentService,
    private readonly databaseService: DatabaseService,
  ) {}

  /**
   * GET /api/stats
   * Populates the Web UI KPI bar with live counts from `uzex.sqlite`.
   */
  @Get('stats')
  getStats() {
    return this.databaseService.getStats();
  }

  /**
   * POST /api/chat (and POST /api/agent/ask)
   * Executes the OpenAI Hybrid Text-to-SQL + Entity RAG loop and returns both
   * the structured `AgentAskResponse` and flattened Web UI convenience fields.
   */
  @Post(['chat', 'agent/ask'])
  @HttpCode(HttpStatus.OK)
  async ask(@Body() body: AskAgentDto): Promise<
    AgentAskResponse & {
      sql: string;
      execMs: number;
      rows: Record<string, any>[];
      columns: string[];
      ragEntities: Array<{ type: string; matched: string; canonicalId: string; score: string }>;
    }
  > {
    if (!body || typeof body.message !== 'string' || !body.message.trim()) {
      throw new BadRequestException(
        'Field "message" is required and must be a non-empty string.',
      );
    }

    const sessionId = body.sessionId?.trim() || 'default-session';
    const res = await this.agentService.ask(
      sessionId,
      body.message.trim(),
      body.model?.trim(),
      { provider: body.provider, apiKey: body.apiKey },
    );

    const primarySql =
      res.sqlQueries.find((q) => q.isPrimary) ||
      res.sqlQueries[res.sqlQueries.length - 1];

    const ragEntities = res.ragMatches.flatMap((rm) =>
      rm.matches.map((m) => ({
        type: m.entityType,
        matched: m.displayLabel || m.canonicalValue,
        canonicalId: m.tableColumn || m.canonicalValue,
        score: String(m.score),
      })),
    );

    return {
      ...res,
      sql: primarySql?.sql || '-- No SQL query required',
      execMs: primarySql?.executionTimeMs || res.durationMs,
      rows: res.tableData?.rows || [],
      columns: res.tableData?.columns || [],
      ragEntities,
    };
  }

  /**
   * GET /api/agent/sessions/:sessionId
   */
  @Get('agent/sessions/:sessionId')
  getSessionHistory(@Param('sessionId') sessionId: string) {
    return {
      sessionId,
      messages: this.agentService.getSessionHistory(sessionId),
    };
  }

  /**
   * DELETE /api/agent/sessions/:sessionId
   */
  @Delete('agent/sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  clearSession(@Param('sessionId') sessionId: string) {
    this.agentService.clearSession(sessionId);
    return {
      sessionId,
      cleared: true,
    };
  }

  /**
   * GET /api/agent/benchmark/questions
   */
  @Get(['benchmark/questions', 'agent/benchmark/questions'])
  getBenchmarkQuestions(): {
    count: number;
    questions: BenchmarkQuestion[];
  } {
    return {
      count: UZEX_BENCHMARK_QUESTIONS.length,
      questions: UZEX_BENCHMARK_QUESTIONS,
    };
  }

  /**
   * POST /api/benchmark (and POST /api/agent/benchmark/run)
   * Executes reference SQL directly against SQLite for deterministic verification,
   * or runs the full provider benchmark suite when an AI API key is configured.
   */
  @Post(['benchmark', 'agent/benchmark/run'])
  @HttpCode(HttpStatus.OK)
  async runBenchmark(@Body() body?: RunBenchmarkDto): Promise<any> {
    const targetId = body?.questionId?.trim() || body?.benchmarkId?.trim();
    const targets = targetId
      ? UZEX_BENCHMARK_QUESTIONS.filter((q) => q.id === targetId)
      : UZEX_BENCHMARK_QUESTIONS;

    // Run deterministic SQL verification directly on SQLite if available
    const sqlResults: Record<string, any> = {};
    for (const q of targets) {
      try {
        const res = await this.databaseService.executeReadOnlyQuery(q.referenceSql, 200);
        sqlResults[q.id] = {
          passed: true,
          execMs: res.executionTimeMs,
          rowsCount: res.rowCount,
          columns: res.columns,
          rows: res.rows,
        };
      } catch (err: any) {
        sqlResults[q.id] = {
          passed: false,
          error: err?.message || String(err),
        };
      }
    }

    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
      return {
        mode: 'sqlite_reference_sql',
        results: sqlResults,
      };
    }

    const suite = await runBenchmarkSuite(this.agentService, {
      questionId: targetId,
      model: body?.model?.trim(),
    });
    return {
      mode: process.env.GEMINI_API_KEY ? 'gemini_end_to_end' : 'openai_end_to_end',
      suite,
      sqlResults,
    };
  }
}
