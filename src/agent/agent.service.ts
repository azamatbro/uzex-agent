import { Injectable, Logger, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';
import { buildSystemPrompt, OPENAI_AGENT_TOOLS } from './prompts';
import { LibraryService } from '../library/library.service';

/**
 * Interface representing a single canonical entity match from RagService.
 */
export interface RagEntityMatch {
  entityType: string;
  canonicalValue: string;
  displayLabel?: string;
  tableColumn?: string;
  score: number;
  metadata?: Record<string, any>;
}

/**
 * Record of a `search_entities` tool invocation and its resolved matches.
 */
export interface RagMatchRecord {
  query: string;
  entityType: string;
  matches: RagEntityMatch[];
  executionTimeMs: number;
}

/**
 * Record of an executed SQL query with timing, row count, and error recovery status.
 */
export interface SqlQueryRecord {
  sql: string;
  purpose?: string;
  columns: string[];
  rowCount: number;
  executionTimeMs: number;
  isPrimary: boolean;
  error?: string;
}

/**
 * Structured table payload for the Web UI sortable data grid and CSV exporter.
 */
export interface TableData {
  columns: string[];
  rows: Record<string, any>[];
}

/**
 * Structured response returned by `AgentService.ask(sessionId, message, model?)`.
 */
export interface AgentAskResponse {
  sessionId: string;
  model: string;
  answer: string;
  sqlQueries: SqlQueryRecord[];
  ragMatches: RagMatchRecord[];
  tableData: TableData | null;
  iterations: number;
  durationMs: number;
}

/**
 * Contract for DatabaseService injected into AgentService.
 */
export interface IDatabaseService {
  executeReadOnlyQuery?(sql: string): Promise<{
    columns: string[];
    rows: Record<string, any>[];
    rowCount: number;
    executionTimeMs: number;
  }>;
  query?(sql: string, params?: any[]): Promise<Record<string, any>[]> | Record<string, any>[];
  all?(sql: string, params?: any[]): Promise<Record<string, any>[]> | Record<string, any>[];
  getSchemaSummary?(): Promise<string | object[]> | string | object[];
}

/**
 * Contract for RagService injected into AgentService.
 */
export interface IRagService {
  searchEntities?(
    query: string,
    entityType?: string,
    limit?: number,
  ): Promise<RagEntityMatch[]> | RagEntityMatch[];
  search?(
    query: string,
    options?: { entityType?: string; limit?: number },
  ): Promise<any[]> | any[];
}

/**
 * Injection tokens for custom providers when classes aren't directly imported by reference.
 */
export const DATABASE_SERVICE_TOKEN = 'DatabaseService';
export const RAG_SERVICE_TOKEN = 'RagService';

const MAX_TOOL_ITERATIONS = 6;
const MAX_SESSION_MESSAGES = 24;
const MAX_TABLE_ROWS_FOR_LLM = 100;
const MAX_TABLE_ROWS_FOR_UI = 1000;
const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  gemini: GEMINI_OPENAI_BASE_URL,
  deepseek: 'https://api.deepseek.com/v1',
} as const;

/**
 * Allowlist of categorical columns supported by `get_column_values` to prevent SQL injection.
 */
const ALLOWED_CATEGORICAL_COLUMNS: Record<string, { table: string; column: string }> = {
  deal_status: { table: 'v_deals_enriched', column: 'deal_status' },
  contract_type: { table: 'v_deals_enriched', column: 'contract_type' },
  contract_form: { table: 'v_deals_enriched', column: 'contract_form' },
  unit: { table: 'v_deals_enriched', column: 'unit' },
  currency: { table: 'v_deals_enriched', column: 'currency' },
  region_code: { table: 'participants', column: 'region_code' },
  seller_region: { table: 'v_deals_enriched', column: 'seller_region' },
  buyer_region: { table: 'v_deals_enriched', column: 'buyer_region' },
  category_name: { table: 'v_deals_enriched', column: 'category_name' },
  product_group: { table: 'v_deals_enriched', column: 'product_group' },
  product_category: { table: 'v_deals_enriched', column: 'product_category' },
  trade_type: { table: 'v_deals_enriched', column: 'trade_type' },
};

const ALLOWED_TABLES = new Set([
  'v_deals_enriched',
  'deals',
  'contracts',
  'participants',
  'brokers',
]);

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly openai?: OpenAI;
  private readonly defaultModel: string;
  private readonly sessions = new Map<string, ChatCompletionMessageParam[]>();

  constructor(
    private readonly databaseService: IDatabaseService,
    private readonly ragService: IRagService,
    private readonly libraryService: LibraryService,
    @Optional() openaiClient?: OpenAI,
  ) {
    const configuredKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    this.openai = openaiClient || (configuredKey
      ? new OpenAI({
          apiKey: configuredKey,
          baseURL: process.env.GEMINI_API_KEY
            ? GEMINI_OPENAI_BASE_URL
            : process.env.OPENAI_BASE_URL || undefined,
        })
      : undefined);
    this.defaultModel =
      (process.env.GEMINI_API_KEY
        ? process.env.GEMINI_MODEL
        : process.env.OPENAI_MODEL) ||
      (process.env.GEMINI_API_KEY ? 'gemini-2.5-flash' : 'gpt-4o');
  }

  /**
   * Primary entry point for asking analytical questions about the UZEX spot dataset.
   * Runs an OpenAI tool-calling loop (up to 6 iterations) with automatic SQL error recovery.
   */
  async ask(
    sessionId: string,
    message: string,
    model?: string,
    config: { provider?: string; apiKey?: string } = {},
  ): Promise<AgentAskResponse> {
    const startTime = Date.now();
    const activeSessionId = sessionId?.trim() || 'default-session';
    const provider = config.provider || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai');
    const activeModel = model?.trim() || this.defaultModel;
    const runtimeClient = config.apiKey
      ? new OpenAI({
          apiKey: config.apiKey,
          baseURL: provider === 'claude'
            ? undefined
            : PROVIDER_BASE_URLS[provider as keyof typeof PROVIDER_BASE_URLS],
        })
      : this.openai;
    if (provider === 'claude') {
      throw new Error('Claude provider requires the native adapter, which is not yet enabled.');
    }
    if (!runtimeClient) throw new Error('No AI API key configured. Add one in Settings.');

    const sqlQueries: SqlQueryRecord[] = [];
    const ragMatches: RagMatchRecord[] = [];
    let primaryTableData: TableData | null = null;
    let fallbackTableData: TableData | null = null;

    // Initialize or retrieve conversation history for this session
    const history = this.getOrCreateSessionHistory(activeSessionId);
    const schemaSummary = await this.safeGetSchemaSummary();
    const libraryContext = this.libraryService.search(message);
    const systemPrompt = buildSystemPrompt(
      [schemaSummary, libraryContext ? `LIBRARY DOCUMENT CONTEXT:\n${libraryContext}` : '']
        .filter(Boolean)
        .join('\n\n'),
    );

    // Construct working message list for this turn
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message },
    ];

    let iterations = 0;
    let finalAnswer = '';

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations += 1;
      this.logger.debug(
        `[Session: ${activeSessionId}] Iteration ${iterations}/${MAX_TOOL_ITERATIONS} (model=${activeModel})`,
      );

      const completion = await runtimeClient.chat.completions.create({
        model: activeModel,
        messages,
        tools: OPENAI_AGENT_TOOLS,
        tool_choice: 'auto',
        temperature: 0,
      });

      const choice = completion.choices[0];
      if (!choice || !choice.message) {
        throw new Error('OpenAI returned an empty completion choice.');
      }

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      // If no tool calls were requested, the assistant has produced its final answer
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        finalAnswer = (assistantMessage.content || '').trim();
        break;
      }

      // Execute all requested tool calls in order
      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCall.type !== 'function') {
          continue;
        }

        const toolName = toolCall.function.name;
        let parsedArgs: Record<string, any> = {};

        try {
          parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch (parseErr: any) {
          const errPayload = {
            error: `Invalid JSON arguments for tool ${toolName}: ${parseErr.message}`,
          };
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(errPayload),
          } as ChatCompletionToolMessageParam);
          continue;
        }

        let toolResultPayload: Record<string, any>;

        if (toolName === 'search_entities') {
          toolResultPayload = await this.handleSearchEntities(parsedArgs, ragMatches);
        } else if (toolName === 'execute_sql') {
          const sqlExec = await this.handleExecuteSql(parsedArgs, sqlQueries);
          toolResultPayload = sqlExec.llmPayload;

          if (sqlExec.tableData && sqlExec.tableData.rows.length > 0) {
            if (sqlExec.isPrimary) {
              primaryTableData = sqlExec.tableData;
            } else {
              fallbackTableData = sqlExec.tableData;
            }
          }
        } else if (toolName === 'get_column_values') {
          toolResultPayload = await this.handleGetColumnValues(parsedArgs, sqlQueries);
        } else {
          toolResultPayload = {
            error: `Unknown tool "${toolName}". Available tools: search_entities, execute_sql, get_column_values.`,
          };
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResultPayload),
        } as ChatCompletionToolMessageParam);
      }
    }

    // If the loop hit max iterations (6) while still calling tools, force a final synthesis response
    if (!finalAnswer) {
      this.logger.warn(
        `[Session: ${activeSessionId}] Reached max iterations (${MAX_TOOL_ITERATIONS}); requesting final synthesis.`,
      );
      const synthesisCompletion = await runtimeClient.chat.completions.create({
        model: activeModel,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'Tool iteration limit reached. Please synthesize the final answer immediately in the user’s language using the exact figures already retrieved above.',
          },
        ],
        tool_choice: 'none',
        temperature: 0,
      });
      finalAnswer = (synthesisCompletion.choices[0]?.message?.content || '').trim();
    }

    // Persist user prompt and final assistant answer in session history
    this.appendSessionExchange(activeSessionId, message, finalAnswer);

    const selectedTableData = primaryTableData ?? fallbackTableData ?? null;
    const durationMs = Date.now() - startTime;

    return {
      sessionId: activeSessionId,
      model: activeModel,
      answer: finalAnswer,
      sqlQueries,
      ragMatches,
      tableData: selectedTableData,
      iterations,
      durationMs,
    };
  }

  /**
   * Tool 1: `search_entities`
   * Queries RagService (with fallback SQLite lexical search if RagService returns empty)
   * to resolve Uzbek/Russian/Latin/Cyrillic terms into canonical database values.
   */
  private async handleSearchEntities(
    args: Record<string, any>,
    ragMatches: RagMatchRecord[],
  ): Promise<Record<string, any>> {
    const startMs = Date.now();
    const query = String(args.query || '').trim();
    const entityType = String(args.entity_type || 'all').trim();
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);

    if (!query) {
      return { error: 'Parameter "query" must be a non-empty string.' };
    }

    try {
      let matches: RagEntityMatch[] = [];

      if (typeof this.ragService?.searchEntities === 'function') {
        const raw = await this.ragService.searchEntities(query, entityType, limit);
        matches = this.normalizeRagMatches(raw);
      } else if (typeof this.ragService?.search === 'function') {
        const raw = await this.ragService.search(query, { entityType, limit });
        matches = this.normalizeRagMatches(raw);
      }

      // Fallback lexical lookup against SQLite if RagService returned no matches
      if (matches.length === 0) {
        matches = await this.fallbackDatabaseEntitySearch(query, entityType, limit);
      }

      const executionTimeMs = Date.now() - startMs;
      ragMatches.push({
        query,
        entityType,
        matches,
        executionTimeMs,
      });

      return {
        query,
        entity_type: entityType,
        match_count: matches.length,
        execution_time_ms: executionTimeMs,
        matches,
        usage_hint:
          'Use the exact `canonicalValue` strings from `matches` in your SQL WHERE clauses.',
      };
    } catch (err: any) {
      this.logger.error(`Error in search_entities("${query}"): ${err.message}`);
      return {
        query,
        entity_type: entityType,
        error: `Entity search failed: ${err.message}`,
      };
    }
  }

  /**
   * Tool 2: `execute_sql`
   * Validates that the SQL is read-only (`SELECT` or `WITH`), executes against SQLite,
   * tracks metrics, and provides automatic SQL error recovery diagnostics on failure.
   */
  private async handleExecuteSql(
    args: Record<string, any>,
    sqlQueries: SqlQueryRecord[],
  ): Promise<{
    llmPayload: Record<string, any>;
    tableData: TableData | null;
    isPrimary: boolean;
  }> {
    const rawSql = String(args.sql || '').trim();
    const purpose = args.purpose ? String(args.purpose).trim() : undefined;
    const isPrimary = Boolean(args.is_primary);

    // 1. Validate read-only SQL
    const validationError = this.validateReadOnlySql(rawSql);
    if (validationError) {
      const failedRecord: SqlQueryRecord = {
        sql: rawSql,
        purpose,
        columns: [],
        rowCount: 0,
        executionTimeMs: 0,
        isPrimary: false,
        error: validationError,
      };
      sqlQueries.push(failedRecord);
      return {
        llmPayload: {
          status: 'error',
          sql: rawSql,
          error: validationError,
          recovery_hint:
            'Only read-only SELECT or WITH queries are permitted. Rewrite the query as a single SELECT statement.',
        },
        tableData: null,
        isPrimary: false,
      };
    }

    // 2. Execute query via DatabaseService with timing and automatic error recovery diagnostics
    const startMs = Date.now();
    try {
      const execResult = await this.runDatabaseQuery(rawSql);
      const executionTimeMs = execResult.executionTimeMs ?? Date.now() - startMs;
      const rows = execResult.rows || [];
      const columns =
        execResult.columns && execResult.columns.length > 0
          ? execResult.columns
          : rows.length > 0
            ? Object.keys(rows[0])
            : [];
      const rowCount = execResult.rowCount ?? rows.length;

      // Mark as primary if explicitly flagged OR if it is the first analytical query returning data
      const effectivePrimary =
        isPrimary || !sqlQueries.some((q) => q.isPrimary && !q.error);

      if (effectivePrimary) {
        for (const prev of sqlQueries) {
          if (isPrimary) {
            prev.isPrimary = false;
          }
        }
      }

      sqlQueries.push({
        sql: rawSql,
        purpose,
        columns,
        rowCount,
        executionTimeMs,
        isPrimary: effectivePrimary,
      });

      const uiTableData: TableData = {
        columns,
        rows: rows.slice(0, MAX_TABLE_ROWS_FOR_UI),
      };

      return {
        llmPayload: {
          status: 'ok',
          sql: rawSql,
          columns,
          row_count: rowCount,
          execution_time_ms: executionTimeMs,
          rows: rows.slice(0, MAX_TABLE_ROWS_FOR_LLM),
          truncated_for_context: rowCount > MAX_TABLE_ROWS_FOR_LLM,
        },
        tableData: uiTableData,
        isPrimary: effectivePrimary,
      };
    } catch (sqlErr: any) {
      const executionTimeMs = Date.now() - startMs;
      const errorMessage = sqlErr?.message || String(sqlErr);

      this.logger.warn(
        `SQL error (${executionTimeMs}ms): ${errorMessage} | SQL: ${rawSql}`,
      );

      sqlQueries.push({
        sql: rawSql,
        purpose,
        columns: [],
        rowCount: 0,
        executionTimeMs,
        isPrimary: false,
        error: errorMessage,
      });

      const recoveryDiagnostics = this.buildSqlErrorRecoveryHint(errorMessage, rawSql);

      return {
        llmPayload: {
          status: 'error',
          sql: rawSql,
          execution_time_ms: executionTimeMs,
          error: errorMessage,
          recovery_hint: recoveryDiagnostics,
        },
        tableData: null,
        isPrimary: false,
      };
    }
  }

  /**
   * Tool 3: `get_column_values`
   * Returns distinct values and counts for any categorical column in the UZEX dataset.
   */
  private async handleGetColumnValues(
    args: Record<string, any>,
    sqlQueries: SqlQueryRecord[],
  ): Promise<Record<string, any>> {
    const requestedColumn = String(args.column || '').trim();
    const requestedTable = args.table ? String(args.table).trim() : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);

    const mapping = ALLOWED_CATEGORICAL_COLUMNS[requestedColumn];
    if (!mapping) {
      return {
        error: `Unsupported categorical column "${requestedColumn}". Allowed columns: ${Object.keys(
          ALLOWED_CATEGORICAL_COLUMNS,
        ).join(', ')}.`,
      };
    }

    const targetTable =
      requestedTable && ALLOWED_TABLES.has(requestedTable)
        ? requestedTable
        : mapping.table;
    const targetColumn =
      targetTable === 'v_deals_enriched' && requestedColumn === 'region_code'
        ? 'seller_region'
        : mapping.column;

    const sql = `SELECT ${targetColumn} AS value, COUNT(*) AS deal_count FROM ${targetTable} GROUP BY ${targetColumn} ORDER BY deal_count DESC LIMIT ${limit}`;

    const startMs = Date.now();
    try {
      const result = await this.runDatabaseQuery(sql);
      const executionTimeMs = result.executionTimeMs ?? Date.now() - startMs;

      sqlQueries.push({
        sql,
        purpose: `Get distinct values and counts for ${targetTable}.${targetColumn}`,
        columns: ['value', 'deal_count'],
        rowCount: result.rows.length,
        executionTimeMs,
        isPrimary: false,
      });

      return {
        table: targetTable,
        column: targetColumn,
        distinct_count: result.rows.length,
        execution_time_ms: executionTimeMs,
        values: result.rows,
      };
    } catch (err: any) {
      const executionTimeMs = Date.now() - startMs;
      const errorMessage = err?.message || String(err);

      sqlQueries.push({
        sql,
        purpose: `Get distinct values for ${targetTable}.${targetColumn}`,
        columns: [],
        rowCount: 0,
        executionTimeMs,
        isPrimary: false,
        error: errorMessage,
      });

      return {
        table: targetTable,
        column: targetColumn,
        error: errorMessage,
        recovery_hint: this.buildSqlErrorRecoveryHint(errorMessage, sql),
      };
    }
  }

  /**
   * Validates that a SQL query is strictly read-only (`SELECT` or `WITH` or `EXPLAIN`).
   */
  public validateReadOnlySql(sql: string): string | null {
    if (!sql || !sql.trim()) {
      return 'SQL query cannot be empty.';
    }

    // Strip leading SQL comments
    const stripped = sql
      .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*/g, '')
      .trim();

    if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(stripped)) {
      return 'Only read-only SELECT or WITH queries are allowed.';
    }

    // Reject multiple statements separated by semicolons
    const withoutTrailingSemicolon = stripped.replace(/;+\s*$/, '');
    if (this.containsUnquotedSemicolon(withoutTrailingSemicolon)) {
      return 'Multiple SQL statements separated by semicolons are not allowed.';
    }

    // Reject mutating or administrative keywords outside quotes
    const strippedLiterals = withoutTrailingSemicolon.replace(
      /'([^']|'')*'|"([^"]|"")*"/g,
      "''",
    );
    const forbiddenMatch = strippedLiterals.match(
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX|PRAGMA)\b/i,
    );
    if (forbiddenMatch) {
      return `Forbidden SQL keyword "${forbiddenMatch[1].toUpperCase()}" detected in read-only mode.`;
    }

    return null;
  }

  /**
   * Generates targeted SQL error recovery hints when SQLite rejects a query.
   */
  private buildSqlErrorRecoveryHint(errorMessage: string, failedSql: string): string {
    const hints: string[] = [
      'Inspect the SQLite error message above and rewrite your query in the next tool call.',
    ];

    if (/no such column/i.test(errorMessage)) {
      hints.push(
        'Valid columns on `v_deals_enriched` are: deal_id, deal_number, deal_date, deal_status, contract_id, contract_number, contract_name, product_name, category_name, tn_ved_code, contract_type, contract_form, lot_size, unit, currency, base_price, deal_price, quantity, delivered_lots, physical_volume, delivered_volume, deal_amount, usd_rate, amount_uzs, seller_id, seller_name, seller_inn, seller_region, seller_broker_code, buyer_id, buyer_name, buyer_inn, buyer_region, buyer_broker_code, payment_date, delivery_date, close_date.',
      );
    }

    if (/no such table/i.test(errorMessage)) {
      hints.push(
        'Valid tables/views are: `v_deals_enriched` (recommended pre-joined view), `deals`, `contracts`, `participants`, `brokers`, and `usd_rates`.',
      );
    }

    if (/no such function/i.test(errorMessage) || /syntax error/i.test(errorMessage)) {
      hints.push(
        'Remember this database is SQLite 3. Use `strftime(\'%Y-%m\', deal_date)` instead of `DATE_TRUNC` or `YEAR()`, `COALESCE` instead of `ISNULL`, and standard `LIMIT n` instead of `TOP n`.',
      );
    }

    if (/ambiguous column name/i.test(errorMessage) && /JOIN/i.test(failedSql)) {
      hints.push(
        'Qualify column names with table aliases when using JOINs, or query `v_deals_enriched` directly to avoid manual joins.',
      );
    }

    return hints.join(' ');
  }

  /**
   * Executes a read-only SQL query across whichever method signature `DatabaseService` exposes.
   */
  private async runDatabaseQuery(sql: string): Promise<{
    columns: string[];
    rows: Record<string, any>[];
    rowCount: number;
    executionTimeMs: number;
  }> {
    const startMs = Date.now();

    if (typeof this.databaseService?.executeReadOnlyQuery === 'function') {
      return await this.databaseService.executeReadOnlyQuery(sql);
    }

    let rows: Record<string, any>[] = [];
    if (typeof this.databaseService?.query === 'function') {
      rows = (await this.databaseService.query(sql)) || [];
    } else if (typeof this.databaseService?.all === 'function') {
      rows = (await this.databaseService.all(sql)) || [];
    } else {
      throw new Error(
        'DatabaseService must implement executeReadOnlyQuery(sql), query(sql), or all(sql).',
      );
    }

    const executionTimeMs = Date.now() - startMs;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs,
    };
  }

  /**
   * Normalizes matches from `RagService` into `RagEntityMatch[]`.
   */
  private normalizeRagMatches(raw: any): RagEntityMatch[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((item) => ({
      entityType: String(item.entityType ?? item.entity_type ?? item.type ?? 'unknown'),
      canonicalValue: String(
        item.canonicalValue ??
          item.canonical_value ??
          item.value ??
          item.name ??
          '',
      ),
      displayLabel: item.displayLabel ?? item.display_label ?? item.label ?? undefined,
      tableColumn: item.tableColumn ?? item.table_column ?? item.column ?? undefined,
      score: typeof item.score === 'number' ? Number(item.score.toFixed(4)) : 1.0,
      metadata: item.metadata ?? undefined,
    }));
  }

  /**
   * Fallback lexical search directly on SQLite if `RagService` returns 0 matches.
   */
  private async fallbackDatabaseEntitySearch(
    query: string,
    entityType: string,
    limit: number,
  ): Promise<RagEntityMatch[]> {
    const escaped = query.replace(/'/g, "''");
    const likePattern = `%${escaped}%`;
    const matches: RagEntityMatch[] = [];

    const searchQueries: Array<{
      type: string;
      column: string;
      sql: string;
    }> = [];

    if (entityType === 'all' || entityType === 'product') {
      searchQueries.push({
        type: 'product',
        column: 'product_name',
        sql: `SELECT DISTINCT product_name AS val, COUNT(*) AS cnt FROM v_deals_enriched WHERE product_name LIKE '${likePattern}' OR contract_name LIKE '${likePattern}' GROUP BY product_name ORDER BY cnt DESC LIMIT ${limit}`,
      });
    }
    if (entityType === 'all' || entityType === 'category') {
      searchQueries.push({
        type: 'category',
        column: 'category_name',
        sql: `SELECT DISTINCT category_name AS val, COUNT(*) AS cnt FROM v_deals_enriched WHERE category_name LIKE '${likePattern}' GROUP BY category_name ORDER BY cnt DESC LIMIT ${limit}`,
      });
    }
    if (entityType === 'all' || entityType === 'tn_ved') {
      searchQueries.push({
        type: 'tn_ved',
        column: 'tn_ved_code',
        sql: `SELECT DISTINCT tn_ved_code AS val, product_name AS label, COUNT(*) AS cnt FROM v_deals_enriched WHERE tn_ved_code LIKE '${likePattern}' GROUP BY tn_ved_code, product_name ORDER BY cnt DESC LIMIT ${limit}`,
      });
    }
    if (
      entityType === 'all' ||
      entityType === 'participant' ||
      entityType === 'inn'
    ) {
      searchQueries.push({
        type: 'participant',
        column: 'seller_name / buyer_name',
        sql: `SELECT DISTINCT name AS val, inn AS label FROM participants WHERE name LIKE '${likePattern}' OR inn LIKE '${likePattern}' LIMIT ${limit}`,
      });
    }
    if (entityType === 'all' || entityType === 'region') {
      searchQueries.push({
        type: 'region',
        column: 'seller_region / buyer_region',
        sql: `SELECT DISTINCT seller_region AS val, COUNT(*) AS cnt FROM v_deals_enriched WHERE seller_region LIKE '${likePattern}' GROUP BY seller_region ORDER BY cnt DESC LIMIT ${limit}`,
      });
    }

    for (const q of searchQueries) {
      try {
        const res = await this.runDatabaseQuery(q.sql);
        for (const row of res.rows) {
          if (row.val) {
            matches.push({
              entityType: q.type,
              canonicalValue: String(row.val),
              displayLabel: row.label ? String(row.label) : undefined,
              tableColumn: q.column,
              score: 0.75,
            });
          }
        }
      } catch {
        // Ignore fallback error on optional tables
      }
    }

    return matches.slice(0, limit);
  }

  private async safeGetSchemaSummary(): Promise<string | undefined> {
    try {
      if (typeof this.databaseService?.getSchemaSummary === 'function') {
        const summary = await this.databaseService.getSchemaSummary();
        return typeof summary === 'string' ? summary : JSON.stringify(summary);
      }
    } catch {
      // Ignore optional schema summary failures
    }
    return undefined;
  }

  private containsUnquotedSemicolon(sql: string): boolean {
    let inSingleQuote = false;
    let inDoubleQuote = false;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      } else if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
        return true;
      }
    }
    return false;
  }

  /**
   * Session history management helpers
   */
  public getSessionHistory(sessionId: string): ChatCompletionMessageParam[] {
    return [...(this.sessions.get(sessionId) || [])];
  }

  public clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getOrCreateSessionHistory(sessionId: string): ChatCompletionMessageParam[] {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, []);
    }
    return this.sessions.get(sessionId)!;
  }

  private appendSessionExchange(
    sessionId: string,
    userMessage: string,
    assistantAnswer: string,
  ): void {
    const history = this.getOrCreateSessionHistory(sessionId);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantAnswer });

    if (history.length > MAX_SESSION_MESSAGES) {
      history.splice(0, history.length - MAX_SESSION_MESSAGES);
    }
  }
}
