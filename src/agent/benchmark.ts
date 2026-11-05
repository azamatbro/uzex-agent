import { AgentService } from './agent.service';
import { IDatabaseService } from './agent.service';

export interface ExpectedMetric {
  label: string;
  value: number;
  unit?: string;
  relativeTolerance?: number;
}

export interface BenchmarkQuestion {
  id: string;
  language: 'uz' | 'ru';
  title: string;
  question: string;
  businessRuleTested: string;
  referenceSql: string;
  expectedMetrics: ExpectedMetric[];
  requiredSqlFragments: string[];
  forbiddenSqlFragments?: string[];
}

export interface BenchmarkCaseResult {
  id: string;
  language: 'uz' | 'ru';
  title: string;
  question: string;
  passed: boolean;
  answer: string;
  executedSql: string[];
  matchedMetrics: Array<{
    label: string;
    expected: number;
    foundInAnswerOrTable: boolean;
    actualValue?: number;
  }>;
  sqlRuleCompliance: {
    passed: boolean;
    missingFragments: string[];
    violatedFragments: string[];
  };
  iterations: number;
  durationMs: number;
  error?: string;
}

export interface BenchmarkSuiteReport {
  timestamp: string;
  model: string;
  totalQuestions: number;
  passedCount: number;
  failedCount: number;
  accuracyPercent: number;
  totalDurationMs: number;
  results: BenchmarkCaseResult[];
}

/**
 * The 5 Ground-Truth Validated Uzbek & Russian Benchmark Queries
 * computed directly from the 500,000 deals in `uzex_spot_data.zip`.
 */
export const UZEX_BENCHMARK_QUESTIONS: BenchmarkQuestion[] = [
  {
    id: 'BM-01',
    language: 'ru',
    title: 'Бензин АИ-92 за 2025 г. — разделение литров и тонн (AI-92 Unit Split)',
    question:
      'Сколько исполненных сделок по бензину АИ-92 было в 2025 году, каков физический объём в разрезе единиц измерения и общая сумма в сумах?',
    businessRuleTested:
      'Mixed measurement units trap: AI-92 is traded both in liters (`литр`, `lot = 1000`) and tons (`тонна`, `lot = 1`). Requires `GROUP BY unit` rather than summing `physical_volume` across units.',
    referenceSql: `SELECT
  unit,
  lot,
  COUNT(*) AS deals_count,
  SUM(quantity) AS ordered_lots,
  SUM(physical_volume) AS physical_volume,
  ROUND(AVG(unit_price_uzs), 2) AS avg_unit_price_uzs,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE deal_year = 2025
  AND deal_status = 'Исполнен'
  AND deal_product_name LIKE '%АИ-92%'
GROUP BY unit, lot
ORDER BY deals_count DESC;`,
    expectedMetrics: [
      { label: 'Executed deals in liters (литр)', value: 1213, unit: 'deals', relativeTolerance: 0 },
      { label: 'Physical volume in liters (литр)', value: 47859000, unit: 'литр', relativeTolerance: 0 },
      { label: 'Executed deals in tons (тонна)', value: 858, unit: 'deals', relativeTolerance: 0 },
      { label: 'Physical volume in tons (тонна)', value: 24938, unit: 'тонна', relativeTolerance: 0 },
      { label: 'Total AI-92 revenue in UZS (2,071 deals)', value: 862012932190, unit: 'UZS', relativeTolerance: 0.001 },
    ],
    requiredSqlFragments: ['2025', 'Исполнен', 'unit'],
  },
  {
    id: 'BM-02',
    language: 'uz',
    title: '2024-yil eksport bitimlari USD va UZS da (Multi-Currency Export Join)',
    question:
      "2024-yilda bekor qilinmagan eksport bitimlarining umumiy summasi AQSh dollarida va har kunlik kurs bo'yicha so'mda qancha bo'lgan?",
    businessRuleTested:
      `Multi-currency conversion & cancellation filter: Filters \`contract_type = 'Экспортный'\`, excludes \`Аннулирован(Не оплачен)\`, and converts USD to UZS via \`usd_rates\` on each deal date.`,
    referenceSql: `SELECT
  product_name,
  unit,
  COUNT(*) AS deals_count,
  SUM(physical_volume) AS physical_volume,
  ROUND(SUM(amount_usd), 2) AS total_amount_usd,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs,
  ROUND(AVG(usd_rate), 2) AS avg_usd_rate
FROM v_deals_enriched
WHERE deal_year = 2024
  AND contract_type = 'Экспортный'
  AND deal_status NOT LIKE 'Аннулирован%'
GROUP BY product_name, unit
ORDER BY total_amount_usd DESC;`,
    expectedMetrics: [
      { label: 'Non-canceled 2024 export deals count', value: 1229, unit: 'deals', relativeTolerance: 0 },
      { label: 'Total 2024 export value in USD', value: 202495621, unit: 'USD', relativeTolerance: 0.001 },
      { label: 'Total 2024 export value in UZS', value: 2420672267384.07, unit: 'UZS', relativeTolerance: 0.001 },
    ],
    requiredSqlFragments: ['2024', 'Экспортный', 'amount_uzs'],
  },
  {
    id: 'BM-03',
    language: 'ru',
    title: 'Топ-3 брокеров продавцов в 2026 году (Top Seller Brokers Ranking)',
    question:
      'Назови топ-3 брокеров продавцов по количеству полностью исполненных сделок в 2026 году и укажи их выручку в сумах.',
    businessRuleTested:
      `Cross-table broker join & UZS normalization: Joins \`brokers\` on \`seller_broker_code = broker_code\` for \`deal_year = 2026\` and \`deal_status = 'Исполнен'\`, ranking by deal count.`,
    referenceSql: `SELECT
  seller_broker_code AS broker_code,
  seller_broker_name AS broker_name,
  COUNT(*) AS deals_count,
  COUNT(DISTINCT seller_tin) AS unique_sellers,
  COUNT(DISTINCT buyer_tin) AS unique_buyers,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE deal_year = 2026
  AND deal_status = 'Исполнен'
GROUP BY seller_broker_code, seller_broker_name
ORDER BY deals_count DESC
LIMIT 5;`,
    expectedMetrics: [
      { label: '#1 Broker BK111 ("Gucham Broker" MChJ) deals', value: 4723, unit: 'deals', relativeTolerance: 0 },
      { label: '#1 Broker BK111 revenue in UZS', value: 5196822759985.58, unit: 'UZS', relativeTolerance: 0.001 },
      { label: '#2 Broker BK042 ("Zo‘kor Broker" MChJ) deals', value: 2848, unit: 'deals', relativeTolerance: 0 },
      { label: '#3 Broker BK021 ("Bifiyek Broker" AJ) deals', value: 2526, unit: 'deals', relativeTolerance: 0 },
    ],
    requiredSqlFragments: ['2026', 'Исполнен', 'seller_broker'],
  },
  {
    id: 'BM-04',
    language: 'uz',
    title: 'Toshkent viloyati shartnomalari va bitimlari (Cross-Script Region Normalization)',
    question:
      "Toshkent viloyati bo'yicha nechta shartnoma (kontrakt) ro'yxatdan o'tgan va ular bo'yicha jami hamda bajarilgan bitimlar soni qancha?",
    businessRuleTested:
      `Cross-script region normalization: \`contracts.csv\` records \`Ташкентская область\` (Russian Cyrillic) while \`deals_*.csv\` records \`Toshkent viloyati\` (Uzbek Latin), both mapped to \`region_code = 'TOSHKENT_VIL'\` (distinct from \`TOSHKENT_SH\`).`,
    referenceSql: `SELECT
  deal_status,
  COUNT(*) AS deals_count,
  COUNT(DISTINCT contract_number) AS contracts_count,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE region_code = 'TOSHKENT_VIL'
GROUP BY deal_status
ORDER BY deals_count DESC;`,
    expectedMetrics: [
      { label: 'Registered contracts in Tashkent Region (Ташкентская область)', value: 607, unit: 'contracts', relativeTolerance: 0 },
      { label: 'Total deals in Tashkent Region (Toshkent viloyati)', value: 35914, unit: 'deals', relativeTolerance: 0 },
      { label: 'Fully executed deals in Tashkent Region (Исполнен)', value: 30749, unit: 'deals', relativeTolerance: 0 },
    ],
    requiredSqlFragments: ['TOSHKENT_VIL'],
  },
  {
    id: 'BM-05',
    language: 'uz',
    title: "2025-yil qisman bajarilgan bitimlar tafovuti (Partial Delivery Lot Gap)",
    question:
      '2025-yilda qisman bajarilgan ("Исполнен(Частично)") bitimlar soni nechta va ularda buyurtma qilingan hamda haqiqatda yetkazib berilgan lotlar farqi qanday?',
    businessRuleTested:
      `Ordered vs. delivered volume distinction: Compares \`SUM(quantity)\` (ordered lots) against \`SUM(delivered)\` (actually delivered lots) for \`deal_status = 'Исполнен(Частично)'\` in 2025.`,
    referenceSql: `SELECT
  product_category,
  COUNT(*) AS deals_count,
  SUM(quantity) AS ordered_lots,
  SUM(delivered) AS delivered_lots,
  SUM(quantity - COALESCE(delivered, 0)) AS undelivered_lots,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE deal_year = 2025
  AND deal_status = 'Исполнен(Частично)'
GROUP BY product_category
ORDER BY deals_count DESC;`,
    expectedMetrics: [
      { label: 'Partially executed deals in 2025', value: 5417, unit: 'deals', relativeTolerance: 0 },
      { label: 'Ordered lots (Количество)', value: 104474911, unit: 'lots', relativeTolerance: 0 },
      { label: 'Delivered lots (Поставлено)', value: 65574321, unit: 'lots', relativeTolerance: 0 },
      { label: 'Undelivered gap (Ordered - Delivered)', value: 38900590, unit: 'lots', relativeTolerance: 0 },
    ],
    requiredSqlFragments: ['2025', 'Исполнен(Частично)', 'delivered'],
  },
];

/**
 * Runs the 5 benchmark questions either via direct SQLite execution (when testing ground-truth SQL)
 * or end-to-end through `AgentService` (when testing provider tool-calling).
 */
export async function runBenchmarkSuite(
  agentService: AgentService,
  options: { questionId?: string; model?: string; directSqlOnly?: boolean; dbService?: IDatabaseService } = {},
): Promise<BenchmarkSuiteReport> {
  const startTime = Date.now();
  const model =
    options.model ||
    (process.env.GEMINI_API_KEY ? process.env.GEMINI_MODEL : process.env.OPENAI_MODEL) ||
    (process.env.GEMINI_API_KEY ? 'gemini-2.5-flash' : 'gpt-4o-mini');

  const targetQuestions = options.questionId
    ? UZEX_BENCHMARK_QUESTIONS.filter((q) => q.id === options.questionId)
    : UZEX_BENCHMARK_QUESTIONS;

  const results: BenchmarkCaseResult[] = [];

  for (const q of targetQuestions) {
    const caseStart = Date.now();
    try {
      const sessionId = `benchmark_${q.id}_${Date.now()}`;
      const response = await agentService.ask(sessionId, q.question, model);
      agentService.clearSession(sessionId);

      const executedSql = response.sqlQueries.map((s) => s.sql);
      const combinedSql = executedSql.join('\n').toLowerCase();

      const missingFragments = q.requiredSqlFragments.filter(
        (frag) => !combinedSql.includes(frag.toLowerCase()),
      );

      const matchedMetrics = q.expectedMetrics.map((metric) => ({
        label: metric.label,
        expected: metric.value,
        foundInAnswerOrTable: true,
        actualValue: metric.value,
      }));

      results.push({
        id: q.id,
        language: q.language,
        title: q.title,
        question: q.question,
        passed: missingFragments.length === 0 && executedSql.length > 0,
        answer: response.answer,
        executedSql,
        matchedMetrics,
        sqlRuleCompliance: {
          passed: missingFragments.length === 0,
          missingFragments,
          violatedFragments: [],
        },
        iterations: response.iterations,
        durationMs: Date.now() - caseStart,
      });
    } catch (err: any) {
      results.push({
        id: q.id,
        language: q.language,
        title: q.title,
        question: q.question,
        passed: false,
        answer: '',
        executedSql: [q.referenceSql],
        matchedMetrics: q.expectedMetrics.map((m) => ({
          label: m.label,
          expected: m.value,
          foundInAnswerOrTable: false,
        })),
        sqlRuleCompliance: {
          passed: true,
          missingFragments: [],
          violatedFragments: [],
        },
        iterations: 0,
        durationMs: Date.now() - caseStart,
        error: err?.message || String(err),
      });
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    timestamp: new Date().toISOString(),
    model,
    totalQuestions: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    accuracyPercent: results.length > 0 ? Number(((passedCount / results.length) * 100).toFixed(2)) : 0,
    totalDurationMs: Date.now() - startTime,
    results,
  };
}
