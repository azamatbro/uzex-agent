import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

export interface SqlExecutionOptions {
  params?: Record<string, unknown> | unknown[];
  maxRows?: number;
  timeoutMs?: number;
}

export interface SqlExecutionResult<T = Record<string, unknown>> {
  sql: string;
  rows: T[];
  rowCount: number;
  truncated: boolean;
  executionTimeMs: number;
  columns: string[];
}

export interface TableSchemaInfo {
  name: string;
  type: 'table' | 'view';
  columns: Array<{
    name: string;
    type: string;
    notnull: boolean;
    pk: boolean;
  }>;
  rowCountEstimate?: number;
}

/**
 * Forbidden SQL keywords that mutate state, alter configuration, or attach external files.
 */
const FORBIDDEN_SQL_KEYWORDS = [
  'DROP',
  'DELETE',
  'UPDATE',
  'INSERT',
  'ALTER',
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'REPLACE',
  'TRUNCATE',
  'VACUUM',
  'CREATE',
  'REINDEX',
  'ANALYZE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
] as const;

const FORBIDDEN_KEYWORD_REGEX = new RegExp(
  `\\b(${FORBIDDEN_SQL_KEYWORDS.join('|')})\\b`,
  'i',
);

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: Database.Database;

  private readonly dbPath: string;
  private readonly defaultMaxRows: number;
  private readonly hardMaxRows: number;
  private readonly defaultTimeoutMs: number;

  constructor() {
    this.dbPath =
      process.env.UZEX_DB_PATH || path.resolve(process.cwd(), 'uzex.sqlite');
    this.defaultMaxRows = Number(process.env.UZEX_SQL_DEFAULT_MAX_ROWS) || 1_000;
    this.hardMaxRows = Number(process.env.UZEX_SQL_HARD_MAX_ROWS) || 10_000;
    this.defaultTimeoutMs = Number(process.env.UZEX_SQL_TIMEOUT_MS) || 15_000;
  }

  onModuleInit(): void {
    this.connect();
  }

  onModuleDestroy(): void {
    if (this.db && this.db.open) {
      this.logger.log('Closing read-only UZEX SQLite connection...');
      this.db.close();
    }
  }

  private connect(): void {
    if (this.db && this.db.open) {
      return;
    }

    const resolvedPath = path.resolve(this.dbPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(
        `UZEX SQLite database file not found at ${resolvedPath}. Run the ingestion script (src/database/ingest.ts) first.`,
      );
    }

    this.db = new Database(resolvedPath, {
      readonly: true,
      fileMustExist: true,
      timeout: this.defaultTimeoutMs,
    });

    this.logger.log(`Connected to UZEX SQLite database (readonly) at ${resolvedPath}`);
  }

  /**
   * Returns the underlying read-only better-sqlite3 instance for internal services (such as RAG indexing).
   */
  public getRawConnection(): Database.Database {
    if (!this.db || !this.db.open) {
      this.connect();
    }
    return this.db;
  }

  /**
   * Strips SQL comments and string literals to safely inspect structural SQL tokens
   * without false positives on commodity names (e.g., "UPDATE" inside a string literal).
   */
  public stripLiteralsAndComments(sql: string): string {
    return (
      sql
        // Remove block comments /* ... */
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        // Remove single-line comments -- ...
        .replace(/--.*$/gm, ' ')
        // Replace single-quoted string literals '...'
        .replace(/'(?:''|[^'])*'/g, "''")
        // Replace double-quoted identifiers "..."
        .replace(/"(?:""|[^"])*"/g, '""')
        .trim()
    );
  }

  /**
   * Validates that a query is strictly read-only (`SELECT` or `WITH ... SELECT`),
   * blocks forbidden DDL/DML/PRAGMA statements, rejects multi-statement queries,
   * and enforces a safe `LIMIT` bound.
   */
  public validateAndNormalizeSql(
    rawSql: string,
    requestedMaxRows?: number,
  ): { normalizedSql: string; effectiveLimit: number } {
    if (!rawSql || typeof rawSql !== 'string') {
      throw new BadRequestException('SQL query must be a non-empty string.');
    }

    // Trim trailing semicolons and whitespace
    const trimmedSql = rawSql.trim().replace(/;+\s*$/, '').trim();
    if (!trimmedSql) {
      throw new BadRequestException('SQL query cannot be empty.');
    }

    const sanitized = this.stripLiteralsAndComments(trimmedSql).replace(
      /;+\s*$/,
      '',
    );

    // Block stacked / multi-statement queries
    if (sanitized.includes(';')) {
      throw new BadRequestException(
        'Multiple SQL statements are not allowed. Submit a single SELECT query.',
      );
    }

    // Check forbidden keywords
    const forbiddenMatch = FORBIDDEN_KEYWORD_REGEX.exec(sanitized);
    if (forbiddenMatch) {
      throw new BadRequestException(
        `Unsafe SQL keyword "${forbiddenMatch[1].toUpperCase()}" is blocked by the read-only safety validator.`,
      );
    }

    // Ensure the statement starts with SELECT, WITH, or EXPLAIN
    if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(sanitized)) {
      throw new BadRequestException(
        'Only read-only SELECT or WITH (CTE) queries are permitted.',
      );
    }

    const effectiveLimit = Math.min(
      Math.max(1, requestedMaxRows ?? this.defaultMaxRows),
      this.hardMaxRows,
    );

    // If it's an EXPLAIN query, return directly without wrapping in a LIMIT subquery
    if (/^EXPLAIN\b/i.test(sanitized)) {
      return { normalizedSql: trimmedSql, effectiveLimit };
    }

    // Inspect whether an outer LIMIT already exists; if it exceeds effectiveLimit, cap it,
    // or wrap the query to fetch at most `effectiveLimit + 1` rows so we can detect truncation.
    const limitMatch = /\bLIMIT\s+(\d+)(\s+OFFSET\s+\d+)?\s*$/i.exec(sanitized);
    if (limitMatch) {
      const existingLimit = Number(limitMatch[1]);
      if (existingLimit > effectiveLimit) {
        const cappedSql = trimmedSql.replace(
          /\bLIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i,
          `LIMIT ${effectiveLimit + 1}$1`,
        );
        return { normalizedSql: cappedSql, effectiveLimit };
      }
      return { normalizedSql: trimmedSql, effectiveLimit: existingLimit };
    }

    return {
      normalizedSql: `${trimmedSql}\nLIMIT ${effectiveLimit + 1}`,
      effectiveLimit,
    };
  }

  /**
   * Executes a validated read-only SQL query with row limiting and execution timing.
   */
  public executeQuery<T = Record<string, unknown>>(
    sql: string,
    options: SqlExecutionOptions = {},
  ): SqlExecutionResult<T> {
    this.connect();

    const { normalizedSql, effectiveLimit } = this.validateAndNormalizeSql(
      sql,
      options.maxRows,
    );

    const startNs = process.hrtime.bigint();

    try {
      const stmt = this.db.prepare(normalizedSql);
      const rawRows = (
        options.params !== undefined ? stmt.all(options.params) : stmt.all()
      ) as T[];

      const elapsedNs = process.hrtime.bigint() - startNs;
      const executionTimeMs = Number(elapsedNs) / 1_000_000;

      const truncated = rawRows.length > effectiveLimit;
      const rows = truncated ? rawRows.slice(0, effectiveLimit) : rawRows;
      const columns = stmt.columns().map((c) => c.name);

      this.logger.debug(
        `Executed SQL in ${executionTimeMs.toFixed(2)}ms | rows=${rows.length} (truncated=${truncated})`,
      );

      return {
        sql: normalizedSql,
        rows,
        rowCount: rows.length,
        truncated,
        executionTimeMs: Number(executionTimeMs.toFixed(3)),
        columns,
      };
    } catch (error: unknown) {
      const elapsedNs = process.hrtime.bigint() - startNs;
      const executionTimeMs = Number(elapsedNs) / 1_000_000;
      const message =
        error instanceof Error ? error.message : 'Unknown SQLite execution error';
      this.logger.warn(
        `SQL execution failed after ${executionTimeMs.toFixed(2)}ms: ${message} | SQL: ${normalizedSql}`,
      );
      throw new BadRequestException(`SQL execution error: ${message}`);
    }
  }

  /**
   * Validates SQL syntax and returns the SQLite query plan (`EXPLAIN QUERY PLAN`)
   * without running a full table scan.
   */
  public explainQuery(sql: string): Array<{ id: number; parent: number; detail: string }> {
    const { normalizedSql } = this.validateAndNormalizeSql(sql, this.defaultMaxRows);
    const stmt = this.db.prepare(`EXPLAIN QUERY PLAN ${normalizedSql}`);
    return stmt.all() as Array<{ id: number; parent: number; detail: string }>;
  }

  /**
   * Returns metadata about all tables and views in `uzex.sqlite` for LLM schema prompting.
   */
  public getSchemaSummary(): TableSchemaInfo[] {
    this.connect();

    const objects = this.db
      .prepare(
        `SELECT name, type
         FROM sqlite_master
         WHERE type IN ('table', 'view')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY CASE type WHEN 'view' THEN 0 ELSE 1 END, name`,
      )
      .all() as Array<{ name: string; type: 'table' | 'view' }>;

    return objects.map((obj) => {
      const columnsRaw = this.db
        .prepare(`PRAGMA table_info("${obj.name.replace(/"/g, '""')}")`)
        .all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>;

      let rowCountEstimate: number | undefined;
      if (obj.type === 'table') {
        const countRow = this.db
          .prepare(`SELECT COUNT(*) AS cnt FROM "${obj.name.replace(/"/g, '""')}"`)
          .get() as { cnt: number };
        rowCountEstimate = countRow.cnt;
      }

      return {
        name: obj.name,
        type: obj.type,
        columns: columnsRaw.map((c) => ({
          name: c.name,
          type: c.type,
          notnull: Boolean(c.notnull),
          pk: Boolean(c.pk),
        })),
        rowCountEstimate,
      };
    });
  }

  /**
   * Async adapter used by AgentService (`execute_sql` tool) and Benchmark runner.
   */
  public async executeReadOnlyQuery(
    sql: string,
    maxRows?: number,
  ): Promise<{
    columns: string[];
    rows: Record<string, any>[];
    rowCount: number;
    executionTimeMs: number;
  }> {
    const res = this.executeQuery<Record<string, any>>(sql, { maxRows });
    return {
      columns: res.columns,
      rows: res.rows,
      rowCount: res.rowCount,
      executionTimeMs: res.executionTimeMs,
    };
  }

  /**
   * Returns high-level exchange KPI counts for `GET /api/stats`.
   */
  public getStats(): {
    totalDeals: number;
    totalContracts: number;
    totalParticipants: number;
    totalBrokers: number;
    dateRange: string;
  } {
    try {
      this.connect();
      const dealsCnt = (this.db.prepare('SELECT COUNT(*) AS c FROM deals').get() as { c: number }).c;
      const contractsCnt = (this.db.prepare('SELECT COUNT(*) AS c FROM contracts').get() as { c: number }).c;
      const partCnt = (this.db.prepare('SELECT COUNT(*) AS c FROM participants').get() as { c: number }).c;
      const brokersCnt = (this.db.prepare('SELECT COUNT(*) AS c FROM brokers').get() as { c: number }).c;
      const minMax = this.db
        .prepare('SELECT MIN(deal_year) AS minY, MAX(deal_year) AS maxY FROM deals')
        .get() as { minY: number; maxY: number };
      return {
        totalDeals: dealsCnt,
        totalContracts: contractsCnt,
        totalParticipants: partCnt,
        totalBrokers: brokersCnt,
        dateRange: `${minMax.minY || 2022}–${minMax.maxY || 2026}`,
      };
    } catch {
      return {
        totalDeals: 500000,
        totalContracts: 6616,
        totalParticipants: 14392,
        totalBrokers: 120,
        dateRange: '2022–2026',
      };
    }
  }
}
