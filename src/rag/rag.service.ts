import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import { CANONICAL_REGIONS } from '../database/ingest';

export type EntityType =
  | 'product'
  | 'tnved'
  | 'category'
  | 'company'
  | 'broker'
  | 'region';

export interface IndexedEntity {
  id: string;
  type: EntityType;
  canonicalValue: string;
  displayName: string;
  aliases: string[];
  normalizedText: string;
  latinTokens: string[];
  trigrams: Set<string>;
  metadata: Record<string, unknown>;
  embedding?: Float32Array;
}

export interface MatchedEntity {
  id: string;
  type: EntityType;
  canonicalValue: string;
  displayName: string;
  score: number;
  matchMethod: 'exact_code' | 'dictionary_alias' | 'lexical' | 'vector_hybrid';
  sqlFilterHint: string;
  metadata: Record<string, unknown>;
}

export interface EntityResolutionResult {
  query: string;
  normalizedLatinQuery: string;
  normalizedCyrillicQuery: string;
  products: MatchedEntity[];
  tnvedCodes: MatchedEntity[];
  categories: MatchedEntity[];
  companies: MatchedEntity[];
  brokers: MatchedEntity[];
  regions: MatchedEntity[];
  promptContext: string;
}

export interface ResolveEntitiesOptions {
  topKPerType?: number;
  minScore?: number;
  useVectorSearch?: boolean;
}

/**
 * Curated bilingual Uzbek (Latin & Cyrillic) <-> Russian commodity dictionary
 * covering the primary spot commodities traded on UZEX (`uzex_spot_data`).
 */
export interface CommodityConcept {
  conceptKey: string;
  uzbekTerms: string[];
  russianTerms: string[];
  englishTerms: string[];
  canonicalSubstrings: string[];
}

export const BILINGUAL_COMMODITY_VOCABULARY: CommodityConcept[] = [
  {
    conceptKey: 'cottonseed_oil',
    uzbekTerms: [
      "paxta yog'i",
      'paxta yogi',
      'paxta moyi',
      'пахта ёғи',
      'пахта мойи',
      'chigit yogi',
    ],
    russianTerms: ['масло хлопковое', 'хлопковое масло', 'рафинированное хлопковое'],
    englishTerms: ['cottonseed oil', 'cotton oil'],
    canonicalSubstrings: ['Масло хлопковое', 'МАСЛО ХЛОПКОВОЕ'],
  },
  {
    conceptKey: 'motor_gasoline',
    uzbekTerms: [
      'benzin',
      'avtobenzin',
      'ai-80',
      'ai-91',
      'ai-92',
      'ai-95',
      'бензин',
      'автобензин',
    ],
    russianTerms: [
      'бензин автомобильный',
      'автомобильный бензин',
      'аи-80',
      'аи-91',
      'аи-92',
      'аи-95',
    ],
    englishTerms: ['gasoline', 'petrol', 'motor fuel'],
    canonicalSubstrings: ['БЕНЗИН АВТОМОБИЛЬНЫЙ', 'Бензин автомобильный'],
  },
  {
    conceptKey: 'ammonium_nitrate',
    uzbekTerms: [
      'selitra',
      'ammiakli selitra',
      'ammiak selitrasi',
      'селитра',
      'аммиакли селитра',
    ],
    russianTerms: ['аммиачная селитра', 'селитра аммиачная', 'нитрат аммония'],
    englishTerms: ['ammonium nitrate', 'saltpeter'],
    canonicalSubstrings: ['Аммиачная селитра', 'АММИАЧНАЯ СЕЛИТРА', 'Селитра аммиачная'],
  },
  {
    conceptKey: 'urea_carbamide',
    uzbekTerms: ['karbamid', 'mochevina', 'карбамид', 'мочевина'],
    russianTerms: ['карбамид', 'мочевина', 'удобрение карбамид'],
    englishTerms: ['urea', 'carbamide'],
    canonicalSubstrings: ['Карбамид', 'КАРБАМИД'],
  },
  {
    conceptKey: 'copper_cathode',
    uzbekTerms: ['mis katod', 'katodli mis', 'mis', 'мис катод', 'мис'],
    russianTerms: ['катод медный', 'медный катод', 'медь катодная'],
    englishTerms: ['copper cathode', 'cathode copper'],
    canonicalSubstrings: ['Катод медный', 'КАТОД МЕДНЫЙ', 'Медь катодная'],
  },
  {
    conceptKey: 'cottonseed_meal',
    uzbekTerms: [
      'shrot',
      'paxta shroti',
      'chigit shroti',
      'шрот',
      'пахта шроти',
      'кунжара',
      'kunjara',
    ],
    russianTerms: ['шрот хлопковых семян', 'шрот хлопковый', 'хлопковый шрот'],
    englishTerms: ['cottonseed meal', 'cotton meal', 'oilcake'],
    canonicalSubstrings: ['Шрот хлопковых семян', 'ШРОТ ХЛОПКОВЫХ СЕМЯН', 'Шрот хлопковый'],
  },
  {
    conceptKey: 'portland_cement',
    uzbekTerms: ['sement', 'portlandsement', 'tsement', 'цемент', 'портландцемент'],
    russianTerms: ['портландцемент', 'цемент', 'пц 400', 'пц 500', 'цем'],
    englishTerms: ['cement', 'portland cement'],
    canonicalSubstrings: ['Портландцемент', 'ПОРТЛАНДЦЕМЕНТ', 'Цемент'],
  },
  {
    conceptKey: 'diesel_fuel',
    uzbekTerms: ['dizel', "dizel yoqilg'isi", 'dizel yonilgisi', 'solyarka', 'дизель'],
    russianTerms: ['топливо дизельное', 'дизельное топливо', 'дизтопливо', 'дт-л', 'дт-з'],
    englishTerms: ['diesel', 'diesel fuel'],
    canonicalSubstrings: ['Топливо дизельное', 'ТОПЛИВО ДИЗЕЛЬНОЕ', 'Дизельное топливо'],
  },
  {
    conceptKey: 'lpg_gas',
    uzbekTerms: [
      'suyultirilgan gaz',
      'propan',
      'butan',
      'spbt',
      'суюлтирилган газ',
      'пропан',
    ],
    russianTerms: [
      'газ углеводородный сжиженный',
      'сжиженный газ',
      'спбт',
      'пропан-бутан',
    ],
    englishTerms: ['lpg', 'liquefied petroleum gas', 'propane'],
    canonicalSubstrings: ['Газ углеводородный сжиженный', 'ГАЗ УГЛЕВОДОРОДНЫЙ СЖИЖЕННЫЙ'],
  },
  {
    conceptKey: 'sugar',
    uzbekTerms: ['shakar', 'oq shakar', 'шакар'],
    russianTerms: ['сахар', 'сахар-песок', 'сахар белый'],
    englishTerms: ['sugar', 'white sugar'],
    canonicalSubstrings: ['Сахар', 'САХАР'],
  },
  {
    conceptKey: 'wheat_flour',
    uzbekTerms: ['un', "bug'doy uni", 'bugdoy uni', 'ун', 'буғдой уни'],
    russianTerms: ['мука пшеничная', 'пшеничная мука', 'мука'],
    englishTerms: ['wheat flour', 'flour'],
    canonicalSubstrings: ['Мука пшеничная', 'МУКА ПШЕНИЧНАЯ'],
  },
  {
    conceptKey: 'wheat_grain',
    uzbekTerms: ["bug'doy", 'bugdoy', 'galla', "g'alla", 'буғдой', 'ғалла'],
    russianTerms: ['пшеница', 'зерно пшеницы', 'пшеница мягкая'],
    englishTerms: ['wheat', 'wheat grain'],
    canonicalSubstrings: ['Пшеница', 'ПШЕНИЦА'],
  },
  {
    conceptKey: 'cotton_husk',
    uzbekTerms: ['sheluxa', "chigit po'stlog'i", 'shulxa', 'шелуха', 'шулха'],
    russianTerms: ['шелуха хлопковая', 'хлопковая шелуха', 'шелуха хлопковых семян'],
    englishTerms: ['cottonseed hull', 'cotton husk'],
    canonicalSubstrings: ['Шелуха хлопковая', 'ШЕЛУХА ХЛОПКОВАЯ', 'Шелуха хлопковых семян'],
  },
  {
    conceptKey: 'cotton_fiber',
    uzbekTerms: ['paxta tolasi', 'paxta', 'tola', 'пахта толаси', 'пахта'],
    russianTerms: ['волокно хлопковое', 'хлопковое волокно', 'хлопок-волокно'],
    englishTerms: ['cotton fiber', 'cotton lint'],
    canonicalSubstrings: ['Волокно хлопковое', 'ВОЛОКНО ХЛОПКОВОЕ'],
  },
  {
    conceptKey: 'coal',
    uzbekTerms: ["ko'mir", 'komir', 'кўмир'],
    russianTerms: ['уголь', 'уголь каменный', 'уголь бурый'],
    englishTerms: ['coal', 'lignite'],
    canonicalSubstrings: ['Уголь', 'УГОЛЬ'],
  },
  {
    conceptKey: 'polyethylene',
    uzbekTerms: ['polietilen', 'granula', 'полиэтилен'],
    russianTerms: ['полиэтилен', 'пэвд', 'пэнд'],
    englishTerms: ['polyethylene', 'pe granules'],
    canonicalSubstrings: ['Полиэтилен', 'ПОЛИЭТИЛЕН'],
  },
  {
    conceptKey: 'polypropylene',
    uzbekTerms: ['polipropilen', 'полипропилен'],
    russianTerms: ['полипропилен'],
    englishTerms: ['polypropylene'],
    canonicalSubstrings: ['Полипропилен', 'ПОЛИПРОПИЛЕН'],
  },
  {
    conceptKey: 'sulfur',
    uzbekTerms: ['oltingugurt', 'олтингугурт', 'sera'],
    russianTerms: ['сера техническая', 'сера', 'сера комовая', 'сера гранулированная'],
    englishTerms: ['sulfur', 'technical sulfur'],
    canonicalSubstrings: ['Сера техническая', 'СЕРА ТЕХНИЧЕСКАЯ', 'Сера'],
  },
  {
    conceptKey: 'rebar_steel',
    uzbekTerms: ['armatura', "po'lat", 'polat', 'temir', 'арматура', 'пўлат'],
    russianTerms: ['прокат арматурный', 'арматура', 'прокат листовой', 'сталь'],
    englishTerms: ['rebar', 'rolled steel', 'reinforcing bars'],
    canonicalSubstrings: ['Прокат арматурный', 'ПРОКАТ АРМАТУРНЫЙ', 'Прокат'],
  },
  {
    conceptKey: 'bitumen',
    uzbekTerms: ['bitum', 'neft bitumi', 'битум'],
    russianTerms: ['битум нефтяной', 'нефтяной битум', 'битум дорожный'],
    englishTerms: ['bitumen', 'asphalt'],
    canonicalSubstrings: ['Битум нефтяной', 'БИТУМ НЕФТЯНОЙ', 'Битум'],
  },
  {
    conceptKey: 'zinc',
    uzbekTerms: ['rux', 'tsink', 'рух', 'цинк'],
    russianTerms: ['цинк', 'цинк металлический'],
    englishTerms: ['zinc'],
    canonicalSubstrings: ['Цинк', 'ЦИНК'],
  },
  {
    conceptKey: 'aluminum',
    uzbekTerms: ['alyuminiy', 'алюминий'],
    russianTerms: ['алюминий', 'алюминий первичный'],
    englishTerms: ['aluminum', 'aluminium'],
    canonicalSubstrings: ['Алюминий', 'АЛЮМИНИЙ'],
  },
];

/**
 * Cyrillic -> Latin transliteration table supporting both Russian and Uzbek Cyrillic characters.
 */
const CYRILLIC_TO_LATIN_MAP: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ғ: "g'",
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'j',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  қ: 'q',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  ў: "o'",
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'x',
  ҳ: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sh',
  ъ: '',
  ы: 'i',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Latin -> Cyrillic transliteration helper for multi-character Uzbek/Russian digraphs and single letters.
 */
const LATIN_DIGRAPHS_TO_CYRILLIC: Array<[RegExp, string]> = [
  [/sh/g, 'ш'],
  [/ch/g, 'ч'],
  [/yo/g, 'ё'],
  [/yu/g, 'ю'],
  [/ya/g, 'я'],
  [/ts/g, 'ц'],
  [/o'/g, 'ў'],
  [/g'/g, 'ғ'],
];

const LATIN_SINGLE_TO_CYRILLIC: Record<string, string> = {
  a: 'а',
  b: 'б',
  c: 'ц',
  d: 'д',
  e: 'е',
  f: 'ф',
  g: 'г',
  h: 'ҳ',
  i: 'и',
  j: 'ж',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'п',
  q: 'қ',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'у',
  v: 'в',
  w: 'в',
  x: 'х',
  y: 'й',
  z: 'з',
};

@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);

  private products: IndexedEntity[] = [];
  private tnvedCodes: IndexedEntity[] = [];
  private categories: IndexedEntity[] = [];
  private companies: IndexedEntity[] = [];
  private brokers: IndexedEntity[] = [];
  private regions: IndexedEntity[] = [];

  private companyByTin = new Map<string, IndexedEntity>();
  private brokerByCode = new Map<string, IndexedEntity>();
  private brokerByTin = new Map<string, IndexedEntity>();
  private tnvedByCode = new Map<string, IndexedEntity>();

  private readonly embeddingApiKey: string | undefined;
  private readonly embeddingBaseUrl: string;
  private readonly embeddingModel: string;
  private readonly embeddingCachePath: string;

  constructor(private readonly databaseService: DatabaseService) {
    const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
    const embeddingApiKey = process.env.OPENAI_API_KEY?.trim();
    const usingGemini = Boolean(geminiApiKey);
    this.embeddingApiKey = geminiApiKey || embeddingApiKey;
    this.embeddingBaseUrl = usingGemini
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : (process.env.OPENAI_BASE_URL?.replace(/\/+$/, '') || 'https://api.openai.com/v1');
    this.embeddingModel = usingGemini
      ? process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
      : process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
    this.embeddingCachePath =
      process.env.UZEX_EMBEDDING_CACHE_PATH ||
      path.resolve(process.cwd(), 'uzex_embeddings.cache.json');
  }

  async onModuleInit(): Promise<void> {
    await this.buildEntityIndex();
  }

  /**
   * Normalizes apostrophes, quotes, punctuation, and case, then transliterates any Cyrillic
   * characters into a unified phonetic Latin representation so Cyrillic and Latin queries match.
   */
  public normalizeToLatin(text: string): string {
    if (!text) return '';
    const lowered = text
      .toLowerCase()
      .replace(/[‘’ʻʼ`´']/g, "'")
      .replace(/[«»"“”()[\]{},.;:/\\|+*=<>!?~@#$%^&]/g, ' ');

    let out = '';
    for (const ch of lowered) {
      out += CYRILLIC_TO_LATIN_MAP[ch] !== undefined ? CYRILLIC_TO_LATIN_MAP[ch] : ch;
    }

    // Also create apostrophe-agnostic normalization (o' -> o, g' -> g) for resilient matching
    return out
      .replace(/o'/g, 'o')
      .replace(/g'/g, 'g')
      .replace(/'/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Converts Latin text into Cyrillic script for direct substring comparisons against Russian/Uzbek Cyrillic names.
   */
  public normalizeToCyrillic(text: string): string {
    if (!text) return '';
    let work = text
      .toLowerCase()
      .replace(/[‘’ʻʼ`´]/g, "'")
      .trim();

    for (const [pattern, replacement] of LATIN_DIGRAPHS_TO_CYRILLIC) {
      work = work.replace(pattern, replacement);
    }

    let out = '';
    for (const ch of work) {
      out += LATIN_SINGLE_TO_CYRILLIC[ch] ?? ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  /**
   * Builds character 3-grams from a normalized string for fuzzy typo-tolerant matching.
   */
  private buildTrigrams(normalized: string): Set<string> {
    const padded = `  ${normalized}  `;
    const trigrams = new Set<string>();
    for (let i = 0; i <= padded.length - 3; i++) {
      trigrams.add(padded.slice(i, i + 3));
    }
    return trigrams;
  }

  /**
   * Creates an IndexedEntity with pre-computed normalized tokens and character trigrams.
   */
  private createIndexedEntity(
    id: string,
    type: EntityType,
    canonicalValue: string,
    displayName: string,
    aliases: string[],
    metadata: Record<string, unknown>,
  ): IndexedEntity {
    const combinedRaw = [canonicalValue, displayName, ...aliases]
      .filter(Boolean)
      .join(' | ');
    const normalizedText = this.normalizeToLatin(combinedRaw);
    const latinTokens = Array.from(
      new Set(normalizedText.split(/\s+/).filter((t) => t.length >= 2)),
    );
    const trigrams = this.buildTrigrams(this.normalizeToLatin(canonicalValue));

    return {
      id,
      type,
      canonicalValue,
      displayName,
      aliases,
      normalizedText,
      latinTokens,
      trigrams,
      metadata,
    };
  }

  /**
   * Indexes all unique products (~230), TN VED codes (~40), categories (8),
   * companies (14,392), brokers (120), and regions (14) from `uzex.sqlite`.
   */
  public async buildEntityIndex(): Promise<void> {
    const startMs = Date.now();
    const db = this.databaseService.getRawConnection();

    // 1. Index Regions (14 canonical regions)
    this.regions = Object.values(CANONICAL_REGIONS).map((reg) =>
      this.createIndexedEntity(
        `region:${reg.code}`,
        'region',
        reg.code,
        `${reg.uz} / ${reg.ru}`,
        [reg.uz, reg.ru, reg.code],
        {
          region_code: reg.code,
          region_uz: reg.uz,
          region_ru: reg.ru,
        },
      ),
    );

    // 2. Index Products (~230 unique products across contracts and deals)
    const productRows = db
      .prepare(
        `SELECT
           product_name,
           MAX(tnved_code) AS sample_tnved,
           MAX(product_category) AS product_category,
           MAX(product_group) AS product_group,
           MAX(industry) AS industry,
           MAX(unit) AS unit,
           COUNT(*) AS contract_count
         FROM (
           SELECT
             product_name,
             tnved_code,
             product_category,
             product_group,
             industry,
             unit
           FROM contracts
           WHERE product_name IS NOT NULL AND product_name != ''
           UNION ALL
           SELECT
             product_name,
             NULL AS tnved_code,
             NULL AS product_category,
             NULL AS product_group,
             NULL AS industry,
             unit
           FROM deals
           WHERE product_name IS NOT NULL AND product_name != ''
         )
         GROUP BY product_name
         ORDER BY contract_count DESC`,
      )
      .all() as Array<{
      product_name: string;
      sample_tnved: string | null;
      product_category: string | null;
      product_group: string | null;
      industry: string | null;
      unit: string | null;
      contract_count: number;
    }>;

    this.products = productRows.map((row, idx) => {
      const bilingualAliases = this.getVocabularyAliasesForProduct(row.product_name);
      return this.createIndexedEntity(
        `product:${idx}`,
        'product',
        row.product_name,
        row.product_name,
        bilingualAliases,
        {
          tnved_code: row.sample_tnved,
          product_category: row.product_category,
          product_group: row.product_group,
          industry: row.industry,
          unit: row.unit,
          occurrences: row.contract_count,
        },
      );
    });

    // 3. Index TN VED codes (~40 unique codes in contracts.csv)
    const tnvedRows = db
      .prepare(
        `SELECT
           tnved_code,
           GROUP_CONCAT(DISTINCT product_name) AS products,
           MAX(product_category) AS product_category,
           MAX(product_group) AS product_group,
           COUNT(*) AS contract_count
         FROM contracts
         WHERE tnved_code IS NOT NULL AND tnved_code != ''
         GROUP BY tnved_code
         ORDER BY contract_count DESC`,
      )
      .all() as Array<{
      tnved_code: string;
      products: string | null;
      product_category: string | null;
      product_group: string | null;
      contract_count: number;
    }>;

    this.tnvedCodes = [];
    this.tnvedByCode.clear();
    for (const row of tnvedRows) {
      const sampleProducts = (row.products || '').split(',').slice(0, 8);
      const entity = this.createIndexedEntity(
        `tnved:${row.tnved_code}`,
        'tnved',
        row.tnved_code,
        `ТН ВЭД ${row.tnved_code} (${sampleProducts.slice(0, 3).join('; ')})`,
        [row.tnved_code, ...sampleProducts, row.product_group || '', row.product_category || ''],
        {
          tnved_code: row.tnved_code,
          sample_products: sampleProducts,
          product_category: row.product_category,
          product_group: row.product_group,
          contract_count: row.contract_count,
        },
      );
      this.tnvedCodes.push(entity);
      this.tnvedByCode.set(row.tnved_code, entity);
    }

    // 4. Index Product Categories, Groups & Industries (8 categories + groups)
    const categoryRows = db
      .prepare(
        `SELECT
           product_category,
           GROUP_CONCAT(DISTINCT product_group) AS groups,
           GROUP_CONCAT(DISTINCT industry) AS industries,
           COUNT(*) AS contract_count
         FROM contracts
         WHERE product_category IS NOT NULL AND product_category != ''
         GROUP BY product_category
         ORDER BY contract_count DESC`,
      )
      .all() as Array<{
      product_category: string;
      groups: string | null;
      industries: string | null;
      contract_count: number;
    }>;

    this.categories = categoryRows.map((row, idx) => {
      const groupList = (row.groups || '').split(',').filter(Boolean);
      const industryList = (row.industries || '').split(',').filter(Boolean);
      return this.createIndexedEntity(
        `category:${idx}`,
        'category',
        row.product_category,
        row.product_category,
        [...groupList, ...industryList],
        {
          product_category: row.product_category,
          product_groups: groupList,
          industries: industryList,
          contract_count: row.contract_count,
        },
      );
    });

    // 5. Index Brokers (120 rows)
    const brokerRows = db
      .prepare(
        `SELECT broker_code, name, tin, region_code, region_uz, region_ru
         FROM brokers`,
      )
      .all() as Array<{
      broker_code: string;
      name: string;
      tin: string | null;
      region_code: string | null;
      region_uz: string | null;
      region_ru: string | null;
    }>;

    this.brokers = [];
    this.brokerByCode.clear();
    this.brokerByTin.clear();
    for (const row of brokerRows) {
      const entity = this.createIndexedEntity(
        `broker:${row.broker_code}`,
        'broker',
        row.broker_code,
        `${row.name} (Код: ${row.broker_code})`,
        [row.name, row.broker_code, row.tin || ''],
        {
          broker_code: row.broker_code,
          name: row.name,
          tin: row.tin,
          region_code: row.region_code,
          region_uz: row.region_uz,
          region_ru: row.region_ru,
        },
      );
      this.brokers.push(entity);
      this.brokerByCode.set(row.broker_code.toLowerCase(), entity);
      if (row.tin) {
        this.brokerByTin.set(row.tin, entity);
      }
    }

    // 6. Index Companies / Participants (14,392 rows)
    const companyRows = db
      .prepare(
        `SELECT tin, name, region_code, region_uz, region_ru, activity_type, role, vat_payer
         FROM participants`,
      )
      .all() as Array<{
      tin: string;
      name: string;
      region_code: string | null;
      region_uz: string | null;
      region_ru: string | null;
      activity_type: string | null;
      role: string | null;
      vat_payer: string | null;
    }>;

    this.companies = [];
    this.companyByTin.clear();
    for (const row of companyRows) {
      const entity = this.createIndexedEntity(
        `company:${row.tin}`,
        'company',
        row.tin,
        `${row.name} (ИНН: ${row.tin})`,
        [row.name, row.tin],
        {
          tin: row.tin,
          name: row.name,
          region_code: row.region_code,
          region_uz: row.region_uz,
          region_ru: row.region_ru,
          activity_type: row.activity_type,
          role: row.role,
          vat_payer: row.vat_payer,
        },
      );
      this.companies.push(entity);
      this.companyByTin.set(row.tin, entity);
    }

    // 7. Optional OpenAI `text-embedding-3-small` vector indexing for semantic entities
    // (products, TN VED codes, categories, brokers, regions)
    if (this.embeddingApiKey) {
      await this.populateVectorEmbeddings([
        ...this.products,
        ...this.tnvedCodes,
        ...this.categories,
        ...this.brokers,
        ...this.regions,
      ]);
    }

    this.logger.log(
      `Indexed UZEX entities in ${Date.now() - startMs}ms: ` +
        `products=${this.products.length}, tnved=${this.tnvedCodes.length}, ` +
        `categories=${this.categories.length}, companies=${this.companies.length}, ` +
        `brokers=${this.brokers.length}, regions=${this.regions.length}, ` +
        `vectorEmbeddings=${Boolean(this.embeddingApiKey)}`,
    );
  }

  /**
   * Returns bilingual Uzbek/Russian/English aliases for a given product name based on
   * the curated UZEX commodity vocabulary.
   */
  private getVocabularyAliasesForProduct(productName: string): string[] {
    const lowerName = productName.toLowerCase();
    const aliases: string[] = [];

    for (const concept of BILINGUAL_COMMODITY_VOCABULARY) {
      const matchesCanonical = concept.canonicalSubstrings.some((sub) =>
        lowerName.includes(sub.toLowerCase()),
      );
      const matchesRussian = concept.russianTerms.some((term) =>
        lowerName.includes(term.toLowerCase()),
      );
      if (matchesCanonical || matchesRussian) {
        aliases.push(
          ...concept.uzbekTerms,
          ...concept.russianTerms,
          ...concept.englishTerms,
        );
      }
    }

    return Array.from(new Set(aliases));
  }

  /**
   * Resolves all relevant UZEX database entities (products, TN VED codes, categories,
   * companies, brokers, and regions) mentioned in a user's natural language query.
   */
  public async resolveEntities(
    query: string,
    options: ResolveEntitiesOptions = {},
  ): Promise<EntityResolutionResult> {
    const topK = options.topKPerType ?? 5;
    const minScore = options.minScore ?? 0.32;
    const normalizedLatinQuery = this.normalizeToLatin(query);
    const normalizedCyrillicQuery = this.normalizeToCyrillic(query);
    const queryTokens = normalizedLatinQuery
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    const queryTrigrams = this.buildTrigrams(normalizedLatinQuery);

    // Optional query vector embedding if OPENAI_API_KEY is configured
    let queryEmbedding: Float32Array | undefined;
    if (this.embeddingApiKey && options.useVectorSearch !== false) {
      queryEmbedding = await this.fetchSingleEmbedding(query);
    }

    // 1. Detect explicit numeric codes in query (9-digit TIN / ИНН, 8-10 digit TN VED, broker codes)
    const exactCompanies: MatchedEntity[] = [];
    const exactBrokers: MatchedEntity[] = [];
    const exactTnveds: MatchedEntity[] = [];

    const digitMatches = query.match(/\b\d{3,10}\b/g) || [];
    for (const numToken of digitMatches) {
      const company = this.companyByTin.get(numToken);
      if (company) {
        exactCompanies.push(this.toMatchedEntity(company, 1.0, 'exact_code'));
      }
      const brokerByTin = this.brokerByTin.get(numToken);
      if (brokerByTin) {
        exactBrokers.push(this.toMatchedEntity(brokerByTin, 1.0, 'exact_code'));
      }
      const brokerByCode = this.brokerByCode.get(numToken.toLowerCase());
      if (brokerByCode) {
        exactBrokers.push(this.toMatchedEntity(brokerByCode, 1.0, 'exact_code'));
      }
      const tnved = this.tnvedByCode.get(numToken);
      if (tnved) {
        exactTnveds.push(this.toMatchedEntity(tnved, 1.0, 'exact_code'));
      }
    }

    // 2. Bilingual vocabulary concept detection for commodities
    const matchedConcepts = this.detectBilingualConcepts(
      query,
      normalizedLatinQuery,
    );

    const products = this.rankEntities(
      this.products,
      normalizedLatinQuery,
      queryTokens,
      queryTrigrams,
      matchedConcepts,
      queryEmbedding,
      topK,
      minScore,
    );

    const tnvedCodes = this.mergeUniqueMatches(
      exactTnveds,
      this.rankEntities(
        this.tnvedCodes,
        normalizedLatinQuery,
        queryTokens,
        queryTrigrams,
        matchedConcepts,
        queryEmbedding,
        topK,
        minScore,
      ),
      topK,
    );

    const categories = this.rankEntities(
      this.categories,
      normalizedLatinQuery,
      queryTokens,
      queryTrigrams,
      matchedConcepts,
      queryEmbedding,
      topK,
      minScore,
    );

    const companies = this.mergeUniqueMatches(
      exactCompanies,
      this.rankEntities(
        this.companies,
        normalizedLatinQuery,
        queryTokens,
        queryTrigrams,
        [],
        undefined, // 14,392 companies use fast lexical + TIN matching
        topK,
        Math.max(minScore, 0.42),
      ),
      topK,
    );

    const brokers = this.mergeUniqueMatches(
      exactBrokers,
      this.rankEntities(
        this.brokers,
        normalizedLatinQuery,
        queryTokens,
        queryTrigrams,
        [],
        queryEmbedding,
        topK,
        minScore,
      ),
      topK,
    );

    const regions = this.rankEntities(
      this.regions,
      normalizedLatinQuery,
      queryTokens,
      queryTrigrams,
      [],
      queryEmbedding,
      topK,
      minScore,
    );

    const result: EntityResolutionResult = {
      query,
      normalizedLatinQuery,
      normalizedCyrillicQuery,
      products,
      tnvedCodes,
      categories,
      companies,
      brokers,
      regions,
      promptContext: '',
    };

    result.promptContext = this.formatPromptContext(result);
    return result;
  }

  /**
   * Detects which bilingual commodity concepts are triggered by the user's query.
   */
  private detectBilingualConcepts(
    rawQuery: string,
    normalizedLatinQuery: string,
  ): CommodityConcept[] {
    const matched: CommodityConcept[] = [];

    for (const concept of BILINGUAL_COMMODITY_VOCABULARY) {
      const allTerms = [
        ...concept.uzbekTerms,
        ...concept.russianTerms,
        ...concept.englishTerms,
      ];
      const isHit = allTerms.some((term) => {
        const normTerm = this.normalizeToLatin(term);
        return (
          normTerm.length >= 2 &&
          (normalizedLatinQuery.includes(normTerm) ||
            rawQuery.toLowerCase().includes(term.toLowerCase()))
        );
      });
      if (isHit) {
        matched.push(concept);
      }
    }

    return matched;
  }

  /**
   * Ranks a collection of IndexedEntity items using dictionary expansion, token overlap,
   * trigram similarity, and optional OpenAI cosine similarity.
   */
  private rankEntities(
    entities: IndexedEntity[],
    normalizedLatinQuery: string,
    queryTokens: string[],
    queryTrigrams: Set<string>,
    matchedConcepts: CommodityConcept[],
    queryEmbedding: Float32Array | undefined,
    topK: number,
    minScore: number,
  ): MatchedEntity[] {
    const scored: MatchedEntity[] = [];

    for (const entity of entities) {
      let dictBoost = 0;
      if (matchedConcepts.length > 0 && entity.type === 'product') {
        const lowerCanonical = entity.canonicalValue.toLowerCase();
        for (const concept of matchedConcepts) {
          if (
            concept.canonicalSubstrings.some((sub) =>
              lowerCanonical.includes(sub.toLowerCase()),
            )
          ) {
            dictBoost = 0.88;
            break;
          }
        }
      }

      // Token overlap score
      let matchedTokenCount = 0;
      for (const qt of queryTokens) {
        if (
          entity.latinTokens.some(
            (et) =>
              et === qt ||
              (qt.length >= 4 && (et.startsWith(qt) || qt.startsWith(et))),
          )
        ) {
          matchedTokenCount++;
        }
      }
      const tokenScore =
        queryTokens.length > 0
          ? matchedTokenCount / Math.max(1, Math.min(queryTokens.length, entity.latinTokens.length))
          : 0;

      // Substring containment bonus
      const normCanonical = this.normalizeToLatin(entity.canonicalValue);
      const substringBoost =
        normCanonical.length >= 3 && normalizedLatinQuery.includes(normCanonical)
          ? 0.85
          : 0;

      // Trigram Jaccard similarity
      let trigramIntersection = 0;
      for (const tri of queryTrigrams) {
        if (entity.trigrams.has(tri)) {
          trigramIntersection++;
        }
      }
      const trigramUnion =
        queryTrigrams.size + entity.trigrams.size - trigramIntersection;
      const trigramScore =
        trigramUnion > 0 ? trigramIntersection / trigramUnion : 0;

      const lexicalScore = Math.max(
        dictBoost,
        substringBoost,
        tokenScore * 0.75 + trigramScore * 0.25,
      );

      let finalScore = lexicalScore;
      let matchMethod: MatchedEntity['matchMethod'] =
        dictBoost > 0 ? 'dictionary_alias' : 'lexical';

      if (queryEmbedding && entity.embedding) {
        const cosine = this.cosineSimilarity(queryEmbedding, entity.embedding);
        // Combine lexical and semantic similarity
        const hybridScore = Math.max(lexicalScore, lexicalScore * 0.55 + cosine * 0.45);
        if (hybridScore > finalScore || cosine >= 0.65) {
          finalScore = Math.max(finalScore, hybridScore);
          if (dictBoost === 0 && cosine > lexicalScore) {
            matchMethod = 'vector_hybrid';
          }
        }
      }

      if (finalScore >= minScore) {
        scored.push(this.toMatchedEntity(entity, finalScore, matchMethod));
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const occA = Number(a.metadata.occurrences ?? a.metadata.contract_count ?? 0);
      const occB = Number(b.metadata.occurrences ?? b.metadata.contract_count ?? 0);
      return occB - occA;
    });

    return scored.slice(0, topK);
  }

  private mergeUniqueMatches(
    primary: MatchedEntity[],
    secondary: MatchedEntity[],
    topK: number,
  ): MatchedEntity[] {
    const seen = new Set<string>();
    const merged: MatchedEntity[] = [];
    for (const item of [...primary, ...secondary]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
      if (merged.length >= topK) break;
    }
    return merged;
  }

  /**
   * Builds a SQL filter hint for each resolved entity so downstream Text-to-SQL prompts
   * use exact database values instead of guessing Cyrillic spellings.
   */
  private toMatchedEntity(
    entity: IndexedEntity,
    score: number,
    matchMethod: MatchedEntity['matchMethod'],
  ): MatchedEntity {
    const escaped = entity.canonicalValue.replace(/'/g, "''");
    let sqlFilterHint = '';

    switch (entity.type) {
      case 'product':
        sqlFilterHint = `product_name = '${escaped}'`;
        break;
      case 'tnved':
        sqlFilterHint = `tnved_code = '${escaped}'`;
        break;
      case 'category':
        sqlFilterHint = `product_category = '${escaped}'`;
        break;
      case 'company':
        sqlFilterHint = `(seller_tin = '${escaped}' OR buyer_tin = '${escaped}')`;
        break;
      case 'broker':
        sqlFilterHint = `(seller_broker_code = '${escaped}' OR buyer_broker_code = '${escaped}')`;
        break;
      case 'region':
        sqlFilterHint = `region_code = '${escaped}'`;
        break;
    }

    return {
      id: entity.id,
      type: entity.type,
      canonicalValue: entity.canonicalValue,
      displayName: entity.displayName,
      score: Number(score.toFixed(4)),
      matchMethod,
      sqlFilterHint,
      metadata: entity.metadata,
    };
  }

  /**
   * Formats resolved entities into a concise markdown block for injection into an LLM SQL prompt.
   */
  public formatPromptContext(res: EntityResolutionResult): string {
    const sections: string[] = [];

    if (res.products.length > 0) {
      sections.push(
        `Matched Products (use exact Cyrillic strings in SQL):\n` +
          res.products
            .map(
              (p) =>
                `  - "${p.canonicalValue}" [SQL: ${p.sqlFilterHint}] (category: ${p.metadata.product_category ?? 'N/A'}, unit: ${p.metadata.unit ?? 'N/A'}, score: ${p.score})`,
            )
            .join('\n'),
      );
    }

    if (res.tnvedCodes.length > 0) {
      sections.push(
        `Matched TN VED Codes:\n` +
          res.tnvedCodes
            .map((t) => `  - ${t.displayName} [SQL: ${t.sqlFilterHint}]`)
            .join('\n'),
      );
    }

    if (res.categories.length > 0) {
      sections.push(
        `Matched Product Categories:\n` +
          res.categories
            .map((c) => `  - "${c.canonicalValue}" [SQL: ${c.sqlFilterHint}]`)
            .join('\n'),
      );
    }

    if (res.regions.length > 0) {
      sections.push(
        `Matched Regions:\n` +
          res.regions
            .map(
              (r) =>
                `  - ${r.canonicalValue} (UZ: "${r.metadata.region_uz}", RU: "${r.metadata.region_ru}") [SQL: ${r.sqlFilterHint}]`,
            )
            .join('\n'),
      );
    }

    if (res.companies.length > 0) {
      sections.push(
        `Matched Participants / Companies:\n` +
          res.companies
            .map(
              (c) =>
                `  - ${c.displayName} (region: ${c.metadata.region_code ?? 'N/A'}, role: ${c.metadata.role ?? 'N/A'}) [SQL: ${c.sqlFilterHint}]`,
            )
            .join('\n'),
      );
    }

    if (res.brokers.length > 0) {
      sections.push(
        `Matched Brokers:\n` +
          res.brokers
            .map(
              (b) =>
                `  - ${b.displayName} (ИНН: ${b.metadata.tin ?? 'N/A'}) [SQL: ${b.sqlFilterHint}]`,
            )
            .join('\n'),
      );
    }

    if (sections.length === 0) {
      return 'No specific entity matches found in RAG index; use broad LIKE or aggregation filters as appropriate.';
    }

    return sections.join('\n\n');
  }

  /**
   * Computes cosine similarity between two Float32Array vectors.
   */
  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * Populates provider embeddings for semantic entities,
   * using a local JSON cache keyed by content SHA-256 hash to avoid redundant API calls.
   */
  private async populateVectorEmbeddings(entities: IndexedEntity[]): Promise<void> {
    if (!this.embeddingApiKey || entities.length === 0) return;

    let cache: Record<string, number[]> = {};
    if (fs.existsSync(this.embeddingCachePath)) {
      try {
        cache = JSON.parse(fs.readFileSync(this.embeddingCachePath, 'utf-8'));
      } catch {
        cache = {};
      }
    }

    const uncached: Array<{ entity: IndexedEntity; hash: string; text: string }> = [];
    for (const entity of entities) {
      const text = `${entity.type}: ${entity.displayName} | ${entity.aliases.slice(0, 6).join(', ')}`;
      const hash = crypto
        .createHash('sha256')
        .update(`${this.embeddingModel}:${text}`)
        .digest('hex');

      const cachedVec = cache[hash];
      if (cachedVec) {
        entity.embedding = new Float32Array(cachedVec);
      } else {
        uncached.push({ entity, hash, text });
      }
    }

    if (uncached.length === 0) {
      return;
    }

    const batchSize = 100;
    for (let i = 0; i < uncached.length; i += batchSize) {
      const slice = uncached.slice(i, i + batchSize);
      try {
        const vectors = await this.requestEmbeddings(
          slice.map((item) => item.text),
        );
        for (let j = 0; j < slice.length; j++) {
          const vec = vectors[j];
          if (vec) {
            slice[j].entity.embedding = new Float32Array(vec);
            cache[slice[j].hash] = vec;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Embedding batch failed (falling back to lexical + bilingual dictionary): ${msg}`,
        );
        return;
      }
    }

    try {
      fs.writeFileSync(this.embeddingCachePath, JSON.stringify(cache));
    } catch (err: unknown) {
      this.logger.warn(`Failed to persist embedding cache: ${err}`);
    }
  }

  private async fetchSingleEmbedding(text: string): Promise<Float32Array | undefined> {
    if (!this.embeddingApiKey) return undefined;
    try {
      const vectors = await this.requestEmbeddings([text]);
      return vectors[0] ? new Float32Array(vectors[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  private async requestEmbeddings(inputs: string[]): Promise<number[][]> {
    const response = await fetch(`${this.embeddingBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.embeddingApiKey}`,
      },
      body: JSON.stringify({
        model: this.embeddingModel,
        input: inputs,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenAI Embeddings HTTP ${response.status}: ${errBody}`);
    }

    const json = (await response.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }

  /**
   * Adapter method invoked by `AgentService` (`search_entities` tool).
   * Maps `EntityResolutionResult` into flat `RagEntityMatch[]` records with SQL filter hints.
   */
  public async searchEntities(
    query: string,
    entityType?: string,
    limit: number = 8,
  ): Promise<
    Array<{
      entityType: string;
      canonicalValue: string;
      displayLabel: string;
      tableColumn: string;
      score: number;
      metadata?: Record<string, unknown>;
    }>
  > {
    const resolved = await this.resolveEntities(query, { topKPerType: limit });
    const allMatches: MatchedEntity[] = [
      ...resolved.products,
      ...resolved.tnvedCodes,
      ...resolved.categories,
      ...resolved.companies,
      ...resolved.brokers,
      ...resolved.regions,
    ];

    const normalizedFilter = (entityType || 'all').toLowerCase();
    const filtered = allMatches.filter((m) => {
      if (!normalizedFilter || normalizedFilter === 'all') return true;
      if (normalizedFilter.includes('product') || normalizedFilter.includes('commodity')) {
        return m.type === 'product' || m.type === 'tnved' || m.type === 'category';
      }
      if (normalizedFilter.includes('company') || normalizedFilter.includes('participant') || normalizedFilter.includes('tin')) {
        return m.type === 'company';
      }
      if (normalizedFilter.includes('broker')) return m.type === 'broker';
      if (normalizedFilter.includes('region')) return m.type === 'region';
      if (normalizedFilter.includes('category')) return m.type === 'category';
      if (normalizedFilter.includes('tnved') || normalizedFilter.includes('tn_ved')) return m.type === 'tnved';
      return true;
    });

    return filtered
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((m) => ({
        entityType: m.type.toUpperCase(),
        canonicalValue: m.canonicalValue,
        displayLabel: m.displayName,
        tableColumn: m.sqlFilterHint,
        score: Number(m.score.toFixed(4)),
        metadata: m.metadata,
      }));
  }
}
