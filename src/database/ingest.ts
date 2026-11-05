import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse';

export interface RegionMapping {
  code: string;
  uz: string;
  ru: string;
}

export const CANONICAL_REGIONS: Record<string, RegionMapping> = {
  TOSHKENT_VIL: {
    code: 'TOSHKENT_VIL',
    uz: 'Toshkent viloyati',
    ru: 'Ташкентская область',
  },
  TOSHKENT_SH: {
    code: 'TOSHKENT_SH',
    uz: 'Toshkent shahri',
    ru: 'г. Ташкент',
  },
  FARGONA: {
    code: 'FARGONA',
    uz: 'Farg‘ona viloyati',
    ru: 'Ферганская область',
  },
  QORAQALPOGISTON: {
    code: 'QORAQALPOGISTON',
    uz: 'Qoraqalpog‘iston Respublikasi',
    ru: 'Республика Каракалпакстан',
  },
  SURXONDARYO: {
    code: 'SURXONDARYO',
    uz: 'Surxondaryo viloyati',
    ru: 'Сурхандарьинская область',
  },
  SAMARQAND: {
    code: 'SAMARQAND',
    uz: 'Samarqand viloyati',
    ru: 'Самаркандская область',
  },
  BUXORO: {
    code: 'BUXORO',
    uz: 'Buxoro viloyati',
    ru: 'Бухарская область',
  },
  QASHQADARYO: {
    code: 'QASHQADARYO',
    uz: 'Qashqadaryo viloyati',
    ru: 'Кашкадарьинская область',
  },
  SIRDARYO: {
    code: 'SIRDARYO',
    uz: 'Sirdaryo viloyati',
    ru: 'Сырдарьинская область',
  },
  NAVOIY: {
    code: 'NAVOIY',
    uz: 'Navoiy viloyati',
    ru: 'Навоийская область',
  },
  ANDIJON: {
    code: 'ANDIJON',
    uz: 'Andijon viloyati',
    ru: 'Андижанская область',
  },
  XORAZM: {
    code: 'XORAZM',
    uz: 'Xorazm viloyati',
    ru: 'Хорезмская область',
  },
  JIZZAX: {
    code: 'JIZZAX',
    uz: 'Jizzax viloyati',
    ru: 'Джизакская область',
  },
  NAMANGAN: {
    code: 'NAMANGAN',
    uz: 'Namangan viloyati',
    ru: 'Наманганская область',
  },
};

/**
 * Normalizes apostrophes and whitespace in region strings so all Uzbek Latin
 * and Russian variants map cleanly to a canonical region entry.
 */
function normalizeRegionKey(raw: string): string {
  return (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’'ʻʼ`´]/g, "'")
    .replace(/\s+/g, ' ');
}

const REGION_LOOKUP: Map<string, RegionMapping> = new Map();
for (const mapping of Object.values(CANONICAL_REGIONS)) {
  REGION_LOOKUP.set(normalizeRegionKey(mapping.uz), mapping);
  REGION_LOOKUP.set(normalizeRegionKey(mapping.ru), mapping);
}
// Additional common aliases found in participant/broker records
REGION_LOOKUP.set('toshkent sh.', CANONICAL_REGIONS.TOSHKENT_SH);
REGION_LOOKUP.set('toshkent shahar', CANONICAL_REGIONS.TOSHKENT_SH);
REGION_LOOKUP.set('город ташкент', CANONICAL_REGIONS.TOSHKENT_SH);
REGION_LOOKUP.set('ташкент', CANONICAL_REGIONS.TOSHKENT_SH);
REGION_LOOKUP.set('қорақалпоғистон республикаси', CANONICAL_REGIONS.QORAQALPOGISTON);

export function resolveRegion(rawRegion: string | undefined | null): RegionMapping {
  if (!rawRegion) {
    return { code: 'UNKNOWN', uz: '', ru: '' };
  }
  const key = normalizeRegionKey(rawRegion);
  const found = REGION_LOOKUP.get(key);
  if (found) {
    return found;
  }
  return {
    code: 'OTHER',
    uz: rawRegion.trim(),
    ru: rawRegion.trim(),
  };
}

/**
 * Parses numbers with space thousand-separators, e.g. "304 547 938.4" -> 304547938.4
 * Also handles comma decimals and percentage suffixes like "10 %".
 */
export function parseSpaceFloat(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw
    .toString()
    .replace(/[\s\u00A0\u202F%]/g, '')
    .replace(',', '.')
    .trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * Converts DD.MM.YYYY date strings into ISO YYYY-MM-DD and integer year.
 */
export function parseDdMmYyyy(raw: string | undefined | null): {
  iso: string | null;
  year: number | null;
} {
  if (!raw) return { iso: null, year: null };
  const trimmed = raw.trim();
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (!match) return { iso: null, year: null };
  const [, dd, mm, yyyy] = match;
  const yearNum = Number(yyyy);
  return {
    iso: `${yyyy}-${mm}-${dd}`,
    year: Number.isFinite(yearNum) ? yearNum : null,
  };
}

interface ContractMeta {
  currency: string;
  lot: number;
  productName: string;
  tnvedCode: string | null;
  category: string | null;
  productGroup: string | null;
  industry: string | null;
  unit: string | null;
}

export interface IngestOptions {
  dataDir: string;
  dbPath: string;
  batchSize?: number;
}

/**
 * Initializes the SQLite schema for UZEX Spot Exchange data.
 */
function initializeSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -256000;
    PRAGMA foreign_keys = OFF;

    DROP VIEW IF EXISTS v_deals_enriched;
    DROP TABLE IF EXISTS deals;
    DROP TABLE IF EXISTS contracts;
    DROP TABLE IF EXISTS participants;
    DROP TABLE IF EXISTS brokers;
    DROP TABLE IF EXISTS usd_rates;
    DROP TABLE IF EXISTS regions;

    CREATE TABLE regions (
      region_code TEXT PRIMARY KEY,
      region_uz TEXT NOT NULL,
      region_ru TEXT NOT NULL
    );

    CREATE TABLE usd_rates (
      rate_date_raw TEXT NOT NULL,
      rate_date_iso TEXT PRIMARY KEY,
      usd_rate REAL NOT NULL
    );

    CREATE TABLE brokers (
      broker_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tin TEXT,
      region_raw TEXT,
      region_code TEXT,
      region_uz TEXT,
      region_ru TEXT
    );

    CREATE TABLE participants (
      tin TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region_raw TEXT,
      region_code TEXT,
      region_uz TEXT,
      region_ru TEXT,
      activity_type TEXT,
      role TEXT,
      vat_payer TEXT
    );

    CREATE TABLE contracts (
      contract_number TEXT PRIMARY KEY,
      product_name TEXT NOT NULL,
      brand TEXT,
      size TEXT,
      grade TEXT,
      product_type TEXT,
      product_class TEXT,
      tnved_code TEXT,
      product_group TEXT,
      product_category TEXT,
      industry TEXT,
      unit TEXT,
      lot REAL NOT NULL DEFAULT 1,
      currency TEXT NOT NULL,
      base_price REAL,
      pledge_raw TEXT,
      pledge_percent REAL,
      delivery_basis TEXT,
      region_raw TEXT,
      region_code TEXT,
      region_uz TEXT,
      region_ru TEXT,
      warehouse_address TEXT,
      trade_type TEXT,
      contract_type TEXT,
      contract_form TEXT,
      payment_term TEXT,
      delivery_term TEXT,
      packaging TEXT,
      seller_tin TEXT,
      reg_date_raw TEXT,
      reg_date_iso TEXT,
      valid_until_raw TEXT,
      valid_until_iso TEXT
    );

    CREATE TABLE deals (
      deal_number TEXT PRIMARY KEY,
      deal_date_raw TEXT,
      deal_date_iso TEXT,
      deal_year INTEGER,
      deal_time TEXT,
      trade_type TEXT,
      quantity REAL NOT NULL DEFAULT 0,
      amount_raw REAL NOT NULL DEFAULT 0,
      start_price_raw REAL,
      contract_number TEXT,
      product_name TEXT,
      lot REAL NOT NULL DEFAULT 1,
      unit TEXT,
      region_raw TEXT,
      region_code TEXT,
      region_uz TEXT,
      region_ru TEXT,
      contract_type TEXT,
      contract_form TEXT,
      deal_status TEXT,
      seller_tin TEXT,
      buyer_tin TEXT,
      seller_broker_code TEXT,
      buyer_broker_code TEXT,
      payment_date_raw TEXT,
      payment_date_iso TEXT,
      delivery_date_raw TEXT,
      delivery_date_iso TEXT,
      delivered REAL,
      currency TEXT NOT NULL DEFAULT 'Узбекский сум',
      usd_rate REAL,
      physical_volume REAL,
      unit_price REAL,
      unit_price_uzs REAL,
      unit_price_usd REAL,
      amount_uzs REAL,
      amount_usd REAL
    );
  `);

  const insertRegion = db.prepare(`
    INSERT OR REPLACE INTO regions (region_code, region_uz, region_ru)
    VALUES (@code, @uz, @ru)
  `);
  const insertRegionsTx = db.transaction((items: RegionMapping[]) => {
    for (const item of items) {
      insertRegion.run(item);
    }
  });
  insertRegionsTx(Object.values(CANONICAL_REGIONS));
}

/**
 * Helper to stream a CSV file and invoke a batch handler.
 */
async function streamCsvBatches(
  filePath: string,
  batchSize: number,
  onBatch: (records: Record<string, string>[]) => void,
): Promise<number> {
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const parser = fs.createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: true,
      relax_quotes: true,
    }),
  );

  let batch: Record<string, string>[] = [];
  let totalRows = 0;

  for await (const record of parser) {
    batch.push(record as Record<string, string>);
    totalRows++;
    if (batch.length >= batchSize) {
      onBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    onBatch(batch);
  }

  return totalRows;
}

/**
 * Resolves the USD exchange rate for an ISO date (YYYY-MM-DD), falling back to
 * the closest preceding date when a deal occurs on a weekend or holiday.
 */
function createUsdRateResolver(
  rateMap: Map<string, number>,
): (isoDate: string | null) => number {
  const sortedDates = Array.from(rateMap.keys()).sort();
  const fallbackRate =
    sortedDates.length > 0 ? rateMap.get(sortedDates[sortedDates.length - 1])! : 11500;
  const earliestRate =
    sortedDates.length > 0 ? rateMap.get(sortedDates[0])! : 10829.1;

  return (isoDate: string | null): number => {
    if (!isoDate || sortedDates.length === 0) return fallbackRate;
    const exact = rateMap.get(isoDate);
    if (exact !== undefined) return exact;

    // Binary search for the largest date <= isoDate
    let low = 0;
    let high = sortedDates.length - 1;
    let bestIdx = -1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (sortedDates[mid] <= isoDate) {
        bestIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (bestIdx >= 0) {
      return rateMap.get(sortedDates[bestIdx])!;
    }
    return earliestRate;
  };
}

/**
 * Runs the complete streaming CSV ingestion pipeline into SQLite (`uzex.sqlite`).
 */
export async function ingestUzexData(options: IngestOptions): Promise<void> {
  const { dataDir, dbPath, batchSize = 10_000 } = options;
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new Database(dbPath);
  const startTime = Date.now();

  try {
    console.log(`[UZEX Ingest] Initializing SQLite schema at ${dbPath}...`);
    initializeSchema(db);

    // 1. Ingest usd_rates.csv
    const rateMap = new Map<string, number>();
    const insertUsdRate = db.prepare(`
      INSERT OR REPLACE INTO usd_rates (rate_date_raw, rate_date_iso, usd_rate)
      VALUES (@rate_date_raw, @rate_date_iso, @usd_rate)
    `);
    const insertUsdBatch = db.transaction((rows: Record<string, string>[]) => {
      for (const r of rows) {
        const rawDate = r['Дата'];
        const { iso } = parseDdMmYyyy(rawDate);
        const rate = parseSpaceFloat(r['Курс']);
        if (iso && rate !== null && rate > 0) {
          insertUsdRate.run({
            rate_date_raw: rawDate,
            rate_date_iso: iso,
            usd_rate: rate,
          });
          rateMap.set(iso, rate);
        }
      }
    });

    const usdCount = await streamCsvBatches(
      path.join(dataDir, 'usd_rates.csv'),
      batchSize,
      insertUsdBatch,
    );
    console.log(`[UZEX Ingest] Loaded ${usdCount} rows from usd_rates.csv`);
    const resolveUsdRate = createUsdRateResolver(rateMap);

    // 2. Ingest brokers.csv
    const insertBroker = db.prepare(`
      INSERT OR REPLACE INTO brokers (
        broker_code, name, tin, region_raw, region_code, region_uz, region_ru
      ) VALUES (
        @broker_code, @name, @tin, @region_raw, @region_code, @region_uz, @region_ru
      )
    `);
    const insertBrokersBatch = db.transaction((rows: Record<string, string>[]) => {
      for (const r of rows) {
        const brokerCode = (r['Код брокера'] || '').trim();
        if (!brokerCode) continue;
        const reg = resolveRegion(r['Регион']);
        insertBroker.run({
          broker_code: brokerCode,
          name: (r['Наименование'] || '').trim(),
          tin: (r['ИНН'] || '').trim() || null,
          region_raw: (r['Регион'] || '').trim() || null,
          region_code: reg.code,
          region_uz: reg.uz,
          region_ru: reg.ru,
        });
      }
    });

    const brokerCount = await streamCsvBatches(
      path.join(dataDir, 'brokers.csv'),
      batchSize,
      insertBrokersBatch,
    );
    console.log(`[UZEX Ingest] Loaded ${brokerCount} rows from brokers.csv`);

    // 3. Ingest participants.csv
    const insertParticipant = db.prepare(`
      INSERT OR REPLACE INTO participants (
        tin, name, region_raw, region_code, region_uz, region_ru,
        activity_type, role, vat_payer
      ) VALUES (
        @tin, @name, @region_raw, @region_code, @region_uz, @region_ru,
        @activity_type, @role, @vat_payer
      )
    `);
    const insertParticipantsBatch = db.transaction((rows: Record<string, string>[]) => {
      for (const r of rows) {
        const tin = (r['ИНН'] || '').trim();
        if (!tin) continue;
        const reg = resolveRegion(r['Регион']);
        insertParticipant.run({
          tin,
          name: (r['Наименование'] || '').trim(),
          region_raw: (r['Регион'] || '').trim() || null,
          region_code: reg.code,
          region_uz: reg.uz,
          region_ru: reg.ru,
          activity_type: (r['Вид деятельности'] || '').trim() || null,
          role: (r['Роль'] || '').trim() || null,
          vat_payer: (r['Плательщик НДС'] || '').trim() || null,
        });
      }
    });

    const participantCount = await streamCsvBatches(
      path.join(dataDir, 'participants.csv'),
      batchSize,
      insertParticipantsBatch,
    );
    console.log(`[UZEX Ingest] Loaded ${participantCount} rows from participants.csv`);

    // 4. Ingest contracts.csv and cache contract metadata for deal enrichment
    const contractMap = new Map<string, ContractMeta>();
    const insertContract = db.prepare(`
      INSERT OR REPLACE INTO contracts (
        contract_number, product_name, brand, size, grade, product_type,
        product_class, tnved_code, product_group, product_category, industry,
        unit, lot, currency, base_price, pledge_raw, pledge_percent,
        delivery_basis, region_raw, region_code, region_uz, region_ru,
        warehouse_address, trade_type, contract_type, contract_form,
        payment_term, delivery_term, packaging, seller_tin,
        reg_date_raw, reg_date_iso, valid_until_raw, valid_until_iso
      ) VALUES (
        @contract_number, @product_name, @brand, @size, @grade, @product_type,
        @product_class, @tnved_code, @product_group, @product_category, @industry,
        @unit, @lot, @currency, @base_price, @pledge_raw, @pledge_percent,
        @delivery_basis, @region_raw, @region_code, @region_uz, @region_ru,
        @warehouse_address, @trade_type, @contract_type, @contract_form,
        @payment_term, @delivery_term, @packaging, @seller_tin,
        @reg_date_raw, @reg_date_iso, @valid_until_raw, @valid_until_iso
      )
    `);

    const insertContractsBatch = db.transaction((rows: Record<string, string>[]) => {
      for (const r of rows) {
        const contractNumber = (r['Номер контракта'] || '').trim();
        if (!contractNumber) continue;

        const reg = resolveRegion(r['Регион']);
        const lot = parseSpaceFloat(r['Лот']) ?? 1;
        const currency = (r['Валюта'] || 'Узбекский сум').trim();
        const basePrice = parseSpaceFloat(r['Базисная цена']);
        const pledgeRaw = (r['Сумма залога'] || '').trim() || null;
        const pledgePercent = parseSpaceFloat(pledgeRaw);
        const regDate = parseDdMmYyyy(r['Дата регистрации']);
        const validUntil = parseDdMmYyyy(r['Действует до']);
        const productName = (r['Наименование продукта'] || '').trim();
        const tnvedCode = (r['Код ТН ВЭД'] || '').trim() || null;
        const productGroup = (r['Группа товара'] || '').trim() || null;
        const productCategory = (r['Категория товара'] || '').trim() || null;
        const industry = (r['Отрасль промышленности'] || '').trim() || null;
        const unit = (r['Единица измерения'] || '').trim() || null;

        insertContract.run({
          contract_number: contractNumber,
          product_name: productName,
          brand: (r['Марка товара'] || '').trim() || null,
          size: (r['Размер товара'] || '').trim() || null,
          grade: (r['Сорт товара'] || '').trim() || null,
          product_type: (r['Тип товара'] || '').trim() || null,
          product_class: (r['Класс товара'] || '').trim() || null,
          tnved_code: tnvedCode,
          product_group: productGroup,
          product_category: productCategory,
          industry,
          unit,
          lot,
          currency,
          base_price: basePrice,
          pledge_raw: pledgeRaw,
          pledge_percent: pledgePercent,
          delivery_basis: (r['Базис поставки'] || '').trim() || null,
          region_raw: (r['Регион'] || '').trim() || null,
          region_code: reg.code,
          region_uz: reg.uz,
          region_ru: reg.ru,
          warehouse_address: (r['Адрес склада'] || '').trim() || null,
          trade_type: (r['Тип торгов'] || '').trim() || null,
          contract_type: (r['Тип контракта'] || '').trim() || null,
          contract_form: (r['Форма контракта'] || '').trim() || null,
          payment_term: (r['Срок оплаты'] || '').trim() || null,
          delivery_term: (r['Срок поставки'] || '').trim() || null,
          packaging: (r['Упаковка'] || '').trim() || null,
          seller_tin: (r['ИНН продавца'] || '').trim() || null,
          reg_date_raw: (r['Дата регистрации'] || '').trim() || null,
          reg_date_iso: regDate.iso,
          valid_until_raw: (r['Действует до'] || '').trim() || null,
          valid_until_iso: validUntil.iso,
        });

        contractMap.set(contractNumber, {
          currency,
          lot,
          productName,
          tnvedCode,
          category: productCategory,
          productGroup,
          industry,
          unit,
        });
      }
    });

    const contractCount = await streamCsvBatches(
      path.join(dataDir, 'contracts.csv'),
      batchSize,
      insertContractsBatch,
    );
    console.log(`[UZEX Ingest] Loaded ${contractCount} rows from contracts.csv`);

    // 5. Ingest deals_2022.csv .. deals_2026.csv
    const insertDeal = db.prepare(`
      INSERT OR REPLACE INTO deals (
        deal_number, deal_date_raw, deal_date_iso, deal_year, deal_time,
        trade_type, quantity, amount_raw, start_price_raw, contract_number,
        product_name, lot, unit, region_raw, region_code, region_uz, region_ru,
        contract_type, contract_form, deal_status, seller_tin, buyer_tin,
        seller_broker_code, buyer_broker_code, payment_date_raw, payment_date_iso,
        delivery_date_raw, delivery_date_iso, delivered, currency, usd_rate,
        physical_volume, unit_price, unit_price_uzs, unit_price_usd,
        amount_uzs, amount_usd
      ) VALUES (
        @deal_number, @deal_date_raw, @deal_date_iso, @deal_year, @deal_time,
        @trade_type, @quantity, @amount_raw, @start_price_raw, @contract_number,
        @product_name, @lot, @unit, @region_raw, @region_code, @region_uz, @region_ru,
        @contract_type, @contract_form, @deal_status, @seller_tin, @buyer_tin,
        @seller_broker_code, @buyer_broker_code, @payment_date_raw, @payment_date_iso,
        @delivery_date_raw, @delivery_date_iso, @delivered, @currency, @usd_rate,
        @physical_volume, @unit_price, @unit_price_uzs, @unit_price_usd,
        @amount_uzs, @amount_usd
      )
    `);

    const insertDealsBatch = db.transaction((rows: Record<string, string>[]) => {
      for (const r of rows) {
        const dealNumber = (r['Номер сделки'] || '').trim();
        if (!dealNumber) continue;

        const contractNumber = (r['Номер контракта'] || '').trim() || null;
        const contractMeta = contractNumber ? contractMap.get(contractNumber) : undefined;

        const dealDate = parseDdMmYyyy(r['Дата сделки']);
        const paymentDate = parseDdMmYyyy(r['Дата оплаты']);
        const deliveryDate = parseDdMmYyyy(r['Дата поставки']);

        const quantity = parseSpaceFloat(r['Количество']) ?? 0;
        const amountRaw = parseSpaceFloat(r['Сумма сделки']) ?? 0;
        const startPriceRaw = parseSpaceFloat(r['Стартовая цена']);
        const dealLot = parseSpaceFloat(r['Лот']) ?? contractMeta?.lot ?? 1;
        const delivered = parseSpaceFloat(r['Поставлено']);

        const reg = resolveRegion(r['Регион']);
        const currency = contractMeta?.currency || 'Узбекский сум';
        const isUsd = currency.toLowerCase().includes('доллар') || currency.toUpperCase() === 'USD';
        const usdRate = resolveUsdRate(dealDate.iso);

        const physicalVolume = quantity * dealLot;
        const unitPrice = physicalVolume > 0 ? amountRaw / physicalVolume : null;

        let amountUzs: number;
        let amountUsd: number;
        if (isUsd) {
          amountUsd = amountRaw;
          amountUzs = amountRaw * usdRate;
        } else {
          amountUzs = amountRaw;
          amountUsd = usdRate > 0 ? amountRaw / usdRate : 0;
        }

        const unitPriceUzs = physicalVolume > 0 ? amountUzs / physicalVolume : null;
        const unitPriceUsd = physicalVolume > 0 ? amountUsd / physicalVolume : null;

        insertDeal.run({
          deal_number: dealNumber,
          deal_date_raw: (r['Дата сделки'] || '').trim() || null,
          deal_date_iso: dealDate.iso,
          deal_year: dealDate.year,
          deal_time: (r['Время сделки'] || '').trim() || null,
          trade_type: (r['Тип торгов'] || '').trim() || null,
          quantity,
          amount_raw: amountRaw,
          start_price_raw: startPriceRaw,
          contract_number: contractNumber,
          product_name: (r['Наименование товара'] || contractMeta?.productName || '').trim() || null,
          lot: dealLot,
          unit: (r['Единица измерения'] || contractMeta?.unit || '').trim() || null,
          region_raw: (r['Регион'] || '').trim() || null,
          region_code: reg.code,
          region_uz: reg.uz,
          region_ru: reg.ru,
          contract_type: (r['Тип контракта'] || '').trim() || null,
          contract_form: (r['Форма контракта'] || '').trim() || null,
          deal_status: (r['Состояние сделки'] || '').trim() || null,
          seller_tin: (r['ИНН продавца'] || '').trim() || null,
          buyer_tin: (r['ИНН покупателя'] || '').trim() || null,
          seller_broker_code: (r['Брокер продавца'] || '').trim() || null,
          buyer_broker_code: (r['Брокер покупателя'] || '').trim() || null,
          payment_date_raw: (r['Дата оплаты'] || '').trim() || null,
          payment_date_iso: paymentDate.iso,
          delivery_date_raw: (r['Дата поставки'] || '').trim() || null,
          delivery_date_iso: deliveryDate.iso,
          delivered,
          currency,
          usd_rate: usdRate,
          physical_volume: physicalVolume,
          unit_price: unitPrice,
          unit_price_uzs: unitPriceUzs,
          unit_price_usd: unitPriceUsd,
          amount_uzs: amountUzs,
          amount_usd: amountUsd,
        });
      }
    });

    const dealYears = [2022, 2023, 2024, 2025, 2026];
    let totalDeals = 0;
    for (const yr of dealYears) {
      const dealFile = path.join(dataDir, `deals_${yr}.csv`);
      const count = await streamCsvBatches(dealFile, batchSize, insertDealsBatch);
      totalDeals += count;
      console.log(`[UZEX Ingest] Loaded ${count} rows from deals_${yr}.csv`);
    }

    // 6. Create analytical indexes and enriched SQL view
    console.log(`[UZEX Ingest] Creating indexes and v_deals_enriched view...`);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_deals_date_iso ON deals(deal_date_iso);
      CREATE INDEX IF NOT EXISTS idx_deals_year ON deals(deal_year);
      CREATE INDEX IF NOT EXISTS idx_deals_contract ON deals(contract_number);
      CREATE INDEX IF NOT EXISTS idx_deals_product ON deals(product_name);
      CREATE INDEX IF NOT EXISTS idx_deals_region_code ON deals(region_code);
      CREATE INDEX IF NOT EXISTS idx_deals_seller_tin ON deals(seller_tin);
      CREATE INDEX IF NOT EXISTS idx_deals_buyer_tin ON deals(buyer_tin);
      CREATE INDEX IF NOT EXISTS idx_deals_seller_broker ON deals(seller_broker_code);
      CREATE INDEX IF NOT EXISTS idx_deals_buyer_broker ON deals(buyer_broker_code);
      CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(deal_status);
      CREATE INDEX IF NOT EXISTS idx_deals_year_region ON deals(deal_year, region_code);
      CREATE INDEX IF NOT EXISTS idx_deals_year_product ON deals(deal_year, product_name);

      CREATE INDEX IF NOT EXISTS idx_contracts_product ON contracts(product_name);
      CREATE INDEX IF NOT EXISTS idx_contracts_tnved ON contracts(tnved_code);
      CREATE INDEX IF NOT EXISTS idx_contracts_category ON contracts(product_category);
      CREATE INDEX IF NOT EXISTS idx_contracts_group ON contracts(product_group);
      CREATE INDEX IF NOT EXISTS idx_contracts_industry ON contracts(industry);
      CREATE INDEX IF NOT EXISTS idx_contracts_region_code ON contracts(region_code);
      CREATE INDEX IF NOT EXISTS idx_contracts_seller_tin ON contracts(seller_tin);

      CREATE INDEX IF NOT EXISTS idx_participants_name ON participants(name);
      CREATE INDEX IF NOT EXISTS idx_participants_region_code ON participants(region_code);
      CREATE INDEX IF NOT EXISTS idx_brokers_name ON brokers(name);
      CREATE INDEX IF NOT EXISTS idx_brokers_tin ON brokers(tin);

      CREATE VIEW v_deals_enriched AS
      SELECT
        d.rowid AS deal_id,
        d.deal_number,
        d.deal_date_raw,
        d.deal_date_iso,
        d.deal_date_iso AS deal_date,
        d.deal_year,
        strftime('%Y-%m', d.deal_date_iso) AS deal_year_month,
        d.deal_time,
        d.trade_type,
        d.deal_status,
        d.contract_number,
        COALESCE(c.product_name, d.product_name) AS product_name,
        d.product_name AS deal_product_name,
        c.brand AS product_brand,
        c.size AS product_size,
        c.grade AS product_grade,
        c.product_type,
        c.product_class,
        c.tnved_code,
        c.tnved_code AS tn_ved_code,
        c.product_group,
        c.product_category,
        c.product_category AS category_name,
        c.industry,
        d.quantity,
        d.lot,
        d.lot AS lot_size,
        d.unit,
        d.physical_volume,
        (COALESCE(d.delivered, 0) * d.lot) AS delivered_volume,
        d.currency,
        d.amount_raw,
        d.start_price_raw,
        c.base_price AS contract_base_price,
        c.pledge_percent,
        c.delivery_basis,
        c.warehouse_address,
        c.payment_term,
        c.delivery_term,
        c.packaging,
        d.usd_rate,
        d.unit_price,
        d.unit_price_uzs,
        d.unit_price_usd,
        d.amount_uzs,
        d.amount_usd,
        d.region_code,
        d.region_uz,
        d.region_ru,
        c.region_code AS contract_region_code,
        c.region_uz AS contract_region_uz,
        c.region_ru AS contract_region_ru,
        d.contract_type,
        d.contract_form,
        d.seller_tin,
        ps.name AS seller_name,
        ps.region_code AS seller_region_code,
        ps.region_uz AS seller_region_uz,
        ps.region_uz AS seller_region,
        ps.region_ru AS seller_region_ru,
        ps.activity_type AS seller_activity_type,
        ps.vat_payer AS seller_vat_payer,
        d.buyer_tin,
        pb.name AS buyer_name,
        pb.region_code AS buyer_region_code,
        pb.region_uz AS buyer_region_uz,
        pb.region_uz AS buyer_region,
        pb.region_ru AS buyer_region_ru,
        pb.activity_type AS buyer_activity_type,
        pb.vat_payer AS buyer_vat_payer,
        d.seller_broker_code,
        bs.name AS seller_broker_name,
        bs.tin AS seller_broker_tin,
        d.buyer_broker_code,
        bb.name AS buyer_broker_name,
        bb.tin AS buyer_broker_tin,
        d.payment_date_iso,
        d.delivery_date_iso,
        d.delivered,
        d.delivered AS delivered_lots
      FROM deals d
      LEFT JOIN contracts c ON c.contract_number = d.contract_number
      LEFT JOIN participants ps ON ps.tin = d.seller_tin
      LEFT JOIN participants pb ON pb.tin = d.buyer_tin
      LEFT JOIN brokers bs ON bs.broker_code = d.seller_broker_code
      LEFT JOIN brokers bb ON bb.broker_code = d.buyer_broker_code;

      ANALYZE;
    `);

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[UZEX Ingest] Completed ingestion of ${totalDeals} deals into ${dbPath} in ${elapsedSec}s.`,
    );
  } finally {
    db.close();
  }
}

// CLI entrypoint when executed directly via `ts-node src/database/ingest.ts`
if (require.main === module) {
  const dataDir = process.env.UZEX_DATA_DIR || path.resolve(process.cwd(), 'uzex_spot_data');
  const dbPath = process.env.UZEX_DB_PATH || path.resolve(process.cwd(), 'uzex.sqlite');
  ingestUzexData({ dataDir, dbPath }).catch((err) => {
    console.error('[UZEX Ingest] Fatal ingestion error:', err);
    process.exit(1);
  });
}
