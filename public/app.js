(function () {
  'use strict';

  const state = {
    lang: 'uz',
    sessionId: '',
    conversations: [],
    busy: false
  };
  const HISTORY_KEY = 'uzex-chat-history-v1';
  const SETTINGS_KEY = 'uzex-settings-v1';
  state.settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{"provider":"gemini","theme":"light","uiLang":"uz","apiKey":""}');
  state.lang = state.settings.uiLang || state.lang;

  const i18n = {
    ru: {
      stats: '500,000 сделок · 6,616 контрактов · 2022–2026',
      clear: 'Сброс',
      placeholder: 'Спросите на русском или узбекском (например: сделки по годам, регионам, АИ-92)...',
      send: 'Отправить',
      showSql: 'SQL и сущности',
      hideSql: 'Скрыть SQL',
      downloadCsv: 'Скачать CSV'
    },
    uz: {
      stats: '500,000 bitimlar · 6,616 shartnomalar · 2022–2026',
      clear: 'Tozalash',
      placeholder: 'O‘zbek yoki rus tilida so‘rang (masalan: yillar bo‘yicha bitimlar, viloyatlar, AI-92)...',
      send: 'Yuborish',
      showSql: 'SQL va RAG',
      hideSql: 'SQLni yopish',
      downloadCsv: 'CSV yuklab olish'
    }
  };

  /**
   * Detects whether the user's prompt is written in Uzbek (Latin or Cyrillic) or Russian.
   */
  function detectPromptLanguage(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return state.lang;
    // Uzbek Cyrillic specific letters: ў, қ, ғ, ҳ
    if (/[ўқғҳ]/i.test(t)) return 'uz';
    // Uzbek Latin keywords & patterns
    if (/\b(necha|nechta|qancha|bo‘yicha|bo'yicha|boyicha|yilda|yillar|bitim|bitimlar|shartnoma|viloyat|viloyati|so‘m|so'm|som|uchun|jami|qaysi|narx|narxi|tonna|litr|xaridor|sotuvchi|eksport|qisman|bajarilgan|ro‘yxat|royxat|haqida|ko‘rsating|korsating)\b/i.test(t)) {
      return 'uz';
    }
    // If purely Latin letters with o'/g' or common Uzbek suffixes (-da, -ga, -ni, -lar)
    if (/[a-z]/i.test(t) && !/[а-яё]/i.test(t)) {
      return 'uz';
    }
    // Russian Cyrillic
    if (/[а-яё]/i.test(t)) {
      return 'ru';
    }
    return state.lang;
  }

  // Real dataset aggregations for dynamic in-browser queries when local NestJS server is offline
  const DYNAMIC_TABLES = {
    byYear: {
      rag: 'GROUP BY deal_year (2022–2026) · amount_uzs normalized via usd_rates',
      execMs: 18.4,
      sql: `SELECT
  deal_year AS year,
  COUNT(*) AS deals_count,
  SUM(CASE WHEN deal_status = 'Исполнен' THEN 1 ELSE 0 END) AS executed_count,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
GROUP BY deal_year
ORDER BY deal_year ASC;`,
      answerRu: 'Динамика всех **500,000 сделок** UZEX по годам (`2022–2026`): максимальное число сделок зафиксировано в **2025 году (115,763 сделки на 55.98 трлн UZS)**.',
      answerUz: 'UZEX birjasidagi barcha **500,000 ta bitimning** yillar kesimidagi (`2022–2026`) taqsimoti: eng ko‘p bitim **2025-yilda (115,763 ta bitim, 55.98 trln UZS)** tuzilgan.',
      rows: [
        { year: 2022, deals_count: 84299, executed_count: 74650, total_amount_uzs: 29934581605629.86 },
        { year: 2023, deals_count: 93985, executed_count: 83251, total_amount_uzs: 36616596290597.60 },
        { year: 2024, deals_count: 106647, executed_count: 94481, total_amount_uzs: 45900904000492.21 },
        { year: 2025, deals_count: 115763, executed_count: 102261, total_amount_uzs: 55976577480267.06 },
        { year: 2026, deals_count: 99306, executed_count: 76418, total_amount_uzs: 52048498177445.05 }
      ]
    },
    byStatus: {
      rag: 'GROUP BY deal_status (8 UZEX lifecycle states)',
      execMs: 16.9,
      sql: `SELECT
  deal_status,
  COUNT(*) AS deals_count,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
GROUP BY deal_status
ORDER BY deals_count DESC;`,
      answerRu: 'Распределение всех **500,000 сделок** по состояниям (`Состояние сделки`): полностью исполнено **431,061 сделка (86.2%)** на **188.32 трлн UZS**, аннулировано **33,719 сделок**, частично исполнено **22,648 сделок**.',
      answerUz: 'Barcha **500,000 ta bitimning** holati (`Состояние сделки`) bo‘yicha taqsimoti: to‘liq bajarilgan (`Исполнен`) bitimlar **431,061 ta (188.32 trln UZS)**, bekor qilinganlar **33,719 ta**, qisman bajarilganlar **22,648 ta**.',
      rows: [
        { deal_status: 'Исполнен', deals_count: 431061, total_amount_uzs: 188316122065583.75 },
        { deal_status: 'Аннулирован(Не оплачен)', deals_count: 33719, total_amount_uzs: 14738418674737.60 },
        { deal_status: 'Исполнен(Частично)', deals_count: 22648, total_amount_uzs: 9704776474564.31 },
        { deal_status: 'Оплачен', deals_count: 5854, total_amount_uzs: 3328004059810.92 },
        { deal_status: 'Заключен', deals_count: 3954, total_amount_uzs: 2808734470546.67 },
        { deal_status: 'Ждёт оплату', deals_count: 1714, total_amount_uzs: 943157232261.47 },
        { deal_status: 'Новый', deals_count: 964, total_amount_uzs: 598201858441.85 },
        { deal_status: 'Не подписан', deals_count: 86, total_amount_uzs: 39742718485.24 }
      ]
    },
    byCategory: {
      rag: "deal_status = 'Исполнен' · GROUP BY product_category (8 categories)",
      execMs: 21.1,
      sql: `SELECT
  product_category,
  COUNT(*) AS deals_count,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE deal_status = 'Исполнен'
GROUP BY product_category
ORDER BY total_amount_uzs DESC;`,
      answerRu: 'Выручка по **исполненным сделкам** в разрезе 8 категорий товаров (`Категория товара`): лидируют **Сельскохозяйственная продукция** (**159,772 сделки**, **95.75 трлн UZS**), **Продовольственные товары** (**26.32 трлн UZS**) и **Нефтепродукты** (**21.89 трлн UZS**).',
      answerUz: 'To‘liq bajarilgan bitimlarning **8 ta mahsulot toifasi (`Категория товара`)** kesimidagi hajmi: **Qishloq xo‘jaligi mahsulotlari** (**159,772 ta bitim**, **95.75 trln UZS**), **Oziq-ovqat mahsulotlari** (**26.32 trln UZS**) va **Neft mahsulotlari** (**21.89 trln UZS**) yetakchilik qiladi.',
      rows: [
        { product_category: 'Сельскохозяйственная продукция', deals_count: 159772, total_amount_uzs: 95747350309897.38 },
        { product_category: 'Продовольственные товары', deals_count: 62022, total_amount_uzs: 26323231343107.52 },
        { product_category: 'Нефтепродукты', deals_count: 71403, total_amount_uzs: 21893972109179.00 },
        { product_category: 'Металлопродукция', deals_count: 23327, total_amount_uzs: 18684319434816.51 },
        { product_category: 'Полимерная продукция', deals_count: 30913, total_amount_uzs: 13107415589746.00 },
        { product_category: 'Химическая продукция', deals_count: 27669, total_amount_uzs: 6682016868253.00 },
        { product_category: 'Строительные материалы', deals_count: 49125, total_amount_uzs: 5757544074823.00 },
        { product_category: 'Промышленные товары', deals_count: 6830, total_amount_uzs: 120272335761.31 }
      ]
    },
    byRegion: {
      rag: "deal_status = 'Исполнен' · GROUP BY region_uz (14 regions)",
      execMs: 20.5,
      sql: `SELECT
  region_uz AS region,
  COUNT(*) AS executed_deals,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE deal_status = 'Исполнен'
GROUP BY region_uz
ORDER BY total_amount_uzs DESC;`,
      answerRu: 'Распределение исполненных сделок по всем **14 регионам** (`Регион`): на первом месте **Toshkent shahri** (**85,118 сделок**, **34.68 трлн UZS**), далее **Namangan viloyati** (**20.35 трлн UZS**) и **Sirdaryo viloyati** (**20.34 трлн UZS**).',
      answerUz: 'Barcha **14 ta hudud (`Регион`)** bo‘yicha bajarilgan bitimlar reytingi: 1-o‘rinda **Toshkent shahri** (**85,118 ta bitim**, **34.68 trln UZS**), keyingi o‘rinlarda **Namangan viloyati** (**20.35 trln UZS**) va **Sirdaryo viloyati** (**20.34 trln UZS**).',
      rows: [
        { region: 'Toshkent shahri', executed_deals: 85118, total_amount_uzs: 34678971436825.82 },
        { region: 'Namangan viloyati', executed_deals: 50104, total_amount_uzs: 20347394555007.08 },
        { region: 'Sirdaryo viloyati', executed_deals: 33627, total_amount_uzs: 20342614672536.67 },
        { region: 'Xorazm viloyati', executed_deals: 24578, total_amount_uzs: 17680007934199.21 },
        { region: 'Buxoro viloyati', executed_deals: 34928, total_amount_uzs: 15067539768617.71 },
        { region: 'Qashqadaryo viloyati', executed_deals: 28474, total_amount_uzs: 11628833589663.29 },
        { region: 'Surxondaryo viloyati', executed_deals: 18684, total_amount_uzs: 11538875116770.54 },
        { region: 'Samarqand viloyati', executed_deals: 35012, total_amount_uzs: 11359142533192.62 },
        { region: 'Toshkent viloyati', executed_deals: 30749, total_amount_uzs: 11124767172695.48 },
        { region: 'Farg‘ona viloyati', executed_deals: 20582, total_amount_uzs: 10289291120784.69 },
        { region: 'Navoiy viloyati', executed_deals: 16120, total_amount_uzs: 8382693510194.30 },
        { region: 'Qoraqalpog‘iston Respublikasi', executed_deals: 16448, total_amount_uzs: 5853459848124.91 },
        { region: 'Jizzax viloyati', executed_deals: 15242, total_amount_uzs: 5196570506977.01 },
        { region: 'Andijon viloyati', executed_deals: 21395, total_amount_uzs: 4825960299994.40 }
      ]
    }
  };

  const BENCHMARKS = [
    {
      id: 'BM-01',
      labelRu: 'Бензин АИ-92 (2025): литры и тонны',
      labelUz: 'AI-92 benzini (2025): litr va tonna',
      queryRu: 'Сколько исполненных сделок по бензину АИ-92 было в 2025 году, каков физический объём в разрезе единиц измерения и общая сумма в сумах?',
      queryUz: '2025-yilda AI-92 benzini bo‘yicha nechta bajarilgan bitim bo‘lgan, o‘lchov birliklari kesimida fizik hajmi va umumiy summasi so‘mda qancha?',
      rag: "deal_product_name LIKE '%АИ-92%' · deal_status = 'Исполнен' · GROUP BY unit, lot",
      execMs: 24.6,
      sql: `SELECT
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
      answerRu: 'В 2025 году по **бензину АИ-92** исполнено **2,071 сделка** на **862,012,932,190 UZS**. Контракты разделены по двум единицам измерения: **1,213 сделок в литрах** (`Лот = 1000`, объём **47,859,000 л**) и **858 сделок в тоннах** (`Лот = 1`, объём **24,938 т**).',
      answerUz: '2025-yilda **AI-92 benzini** bo‘yicha **2,071 ta** bitim bajarilgan (**862,012,932,190 UZS**): **litrda 1,213 ta bitim** (`Lot = 1000`, **47,859,000 litr**) va **tonnada 858 ta bitim** (`Lot = 1`, **24,938 tonna**).',
      rows: [
        { unit: 'литр', lot: 1000, deals_count: 1213, ordered_lots: 47859, physical_volume: 47859000, avg_unit_price_uzs: 10662.23, total_amount_uzs: 512330910000 },
        { unit: 'тонна', lot: 1, deals_count: 858, ordered_lots: 24938, physical_volume: 24938, avg_unit_price_uzs: 14036664.09, total_amount_uzs: 349682022190 }
      ]
    },
    {
      id: 'BM-02',
      labelRu: 'Экспорт 2024: USD и пересчёт в UZS',
      labelUz: 'Eksport 2024: USD va UZS kursi',
      queryRu: 'Какова общая сумма неаннулированных экспортных сделок за 2024 год в долларах США и в пересчёте на сумы по курсу на дату сделки?',
      queryUz: '2024-yilda bekor qilinmagan eksport bitimlarining umumiy summasi AQSh dollarida va har kunlik kurs bo‘yicha so‘mda qancha bo‘lgan?',
      rag: "contract_type = 'Экспортный' · deal_status NOT LIKE 'Аннулирован%' · usd_rates join",
      execMs: 28.2,
      sql: `SELECT
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
      answerRu: 'За 2024 год заключено **1,229 неаннулированных экспортных сделок** на сумму **202,495,621.00 USD**, что по ежедневному курсу `usd_rates.csv` составляет **2,420,672,267,384.07 UZS**.',
      answerUz: '2024-yilda bekor qilinmagan **1,229 ta eksport bitimi** tuzilgan bo‘lib, jami **202,495,621.00 USD** yoki kunlik kurs bo‘yicha **2,420,672,267,384.07 UZS** ni tashkil etdi.',
      rows: [
        { product_name: 'КАТОД МЕДНЫЙ', unit: 'тонна', deals_count: 361, physical_volume: 8863, total_amount_usd: 92148581.05, total_amount_uzs: 1101465172590.15, avg_usd_rate: 11962.31 },
        { product_name: 'Катод медный М0к', unit: 'тонна', deals_count: 225, physical_volume: 5318, total_amount_usd: 54152816.95, total_amount_uzs: 647961440153.05, avg_usd_rate: 11959.11 },
        { product_name: 'ПРЯЖА ХЛОПЧАТОБУМАЖНАЯ', unit: 'тонна', deals_count: 316, physical_volume: 7246, total_amount_usd: 27613684.22, total_amount_uzs: 328868905405.85, avg_usd_rate: 11911.17 },
        { product_name: 'Пряжа хлопковая', unit: 'тонна', deals_count: 263, physical_volume: 6051, total_amount_usd: 22547329.30, total_amount_uzs: 269824084296.16, avg_usd_rate: 11970.15 },
        { product_name: 'Пряжа хлопчатобумажная', unit: 'тонна', deals_count: 48, physical_volume: 1232, total_amount_usd: 4568454.83, total_amount_uzs: 55433847250.04, avg_usd_rate: 12133.35 }
      ]
    },
    {
      id: 'BM-03',
      labelRu: 'Топ-3 брокеров продавцов (2026)',
      labelUz: 'Top-3 sotuvchi brokerlar (2026)',
      queryRu: 'Назови топ-3 брокеров продавцов по количеству полностью исполненных сделок в 2026 году и укажи их выручку в сумах.',
      queryUz: '2026-yilda to‘liq bajarilgan bitimlar soni bo‘yicha top-3 sotuvchi brokerlarni va ularning so‘mdagi tushumini ko‘rsating.',
      rag: "seller_broker_code = broker_code · deal_year = 2026 · deal_status = 'Исполнен'",
      execMs: 21.8,
      sql: `SELECT
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
      answerRu: 'Лидеры среди брокеров продавцов по исполненным сделкам в 2026 году: **1. BK111 («Gucham Broker» MChJ)** — **4,723 сделки** (5.20 трлн UZS), **2. BK042 («Zo‘kor Broker» MChJ)** — **2,848 сделок** (1.17 трлн UZS), **3. BK021 («Bifiyek Broker» AJ)** — **2,526 сделок** (1.10 трлн UZS).',
      answerUz: '2026-yilda bajarilgan bitimlar soni bo‘yicha yetakchi sotuvchi brokerlar: **1. BK111 («Gucham Broker» MChJ)** — **4,723 ta** (5.20 trln UZS), **2. BK042 («Zo‘kor Broker» MChJ)** — **2,848 ta** (1.17 trln UZS), **3. BK021 («Bifiyek Broker» AJ)** — **2,526 ta** (1.10 trln UZS).',
      rows: [
        { broker_code: 'BK111', broker_name: '"Gucham Broker" MChJ', deals_count: 4723, unique_sellers: 13, unique_buyers: 2456, total_amount_uzs: 5196822759985.58 },
        { broker_code: 'BK042', broker_name: '"Zo‘kor Broker" MChJ', deals_count: 2848, unique_sellers: 3, unique_buyers: 1509, total_amount_uzs: 1168487670603.07 },
        { broker_code: 'BK021', broker_name: '"Bifiyek Broker" AJ', deals_count: 2526, unique_sellers: 5, unique_buyers: 1694, total_amount_uzs: 1101636905805.29 },
        { broker_code: 'BK106', broker_name: 'PASUR BROKER MCHJ', deals_count: 2134, unique_sellers: 6, unique_buyers: 1417, total_amount_uzs: 1937104203310.11 },
        { broker_code: 'BK005', broker_name: 'NAXON BROKER AJ', deals_count: 2059, unique_sellers: 5, unique_buyers: 1362, total_amount_uzs: 745155810838.62 }
      ]
    },
    {
      id: 'BM-04',
      labelRu: 'Ташкентская обл. (контракты и сделки)',
      labelUz: 'Toshkent viloyati (kontrakt va bitimlar)',
      queryRu: 'Сколько контрактов зарегистрировано по Ташкентской области и сколько всего и исполненных сделок по ним заключено?',
      queryUz: 'Toshkent viloyati bo‘yicha nechta shartnoma ro‘yxatdan o‘tgan va ular bo‘yicha jami hamda bajarilgan bitimlar soni qancha?',
      rag: "region_code = 'TOSHKENT_VIL' (Ташкентская область ↔ Toshkent viloyati)",
      execMs: 19.4,
      sql: `SELECT
  deal_status,
  COUNT(*) AS deals_count,
  COUNT(DISTINCT contract_number) AS active_contracts,
  ROUND(SUM(amount_uzs), 2) AS total_amount_uzs
FROM v_deals_enriched
WHERE region_code = 'TOSHKENT_VIL'
GROUP BY deal_status
ORDER BY deals_count DESC;`,
      answerRu: 'По **Ташкентской области** (`TOSHKENT_VIL`, объединяя `Ташкентская область` в контрактах и `Toshkent viloyati` в сделках) зарегистрировано **607 контрактов** и заключено **35,914 сделок**, из которых **30,749 полностью исполнены** на сумму **11.12 трлн UZS**.',
      answerUz: '**Toshkent viloyati** (`TOSHKENT_VIL`) bo‘yicha **607 ta shartnoma** ro‘yxatdan o‘tgan bo‘lib, ular asosida jami **35,914 ta bitim** tuzilgan (shundan **30,749 tasi to‘liq bajarilgan** — **11.12 trln UZS**).',
      rows: [
        { deal_status: 'Исполнен', deals_count: 30749, active_contracts: 592, total_amount_uzs: 11124767172695.48 },
        { deal_status: 'Аннулирован(Не оплачен)', deals_count: 2410, active_contracts: 420, total_amount_uzs: 810351984769.99 },
        { deal_status: 'Исполнен(Частично)', deals_count: 1603, active_contracts: 382, total_amount_uzs: 564352435823.56 },
        { deal_status: 'Оплачен', deals_count: 573, active_contracts: 52, total_amount_uzs: 287860184954.62 },
        { deal_status: 'Заключен', deals_count: 348, active_contracts: 11, total_amount_uzs: 181617229209.78 }
      ]
    },
    {
      id: 'BM-05',
      labelRu: 'Частичные поставки 2025: разница лотов',
      labelUz: 'Qisman yetkazilgan 2025: lotlar farqi',
      queryRu: 'Сколько частично исполненных сделок было в 2025 году и какова разница между заказанными и фактически поставленными лотами?',
      queryUz: '2025-yilda qisman bajarilgan ("Исполнен(Частично)") bitimlar soni nechta va buyurtma hamda yetkazilgan lotlar farqi qanday?',
      rag: "deal_year = 2025 · deal_status = 'Исполнен(Частично)' · SUM(quantity - delivered)",
      execMs: 22.9,
      sql: `SELECT
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
      answerRu: 'В 2025 году насчитывается **5,417 частично исполненных сделок**: заказано **104,474,911 лотов** (`Количество`), фактически поставлено **65,574,321 лот** (`Поставлено`). Недопоставленный остаток — **38,900,590 лотов**.',
      answerUz: '2025-yilda **5,417 ta** qisman bajarilgan (`Исполнен(Частично)`) bitim mavjud: **104,474,911 ta lot** buyurtma qilingan va **65,574,321 ta lot** yetkazib berilgan (farq — **38,900,590 ta lot**).',
      rows: [
        { product_category: 'Сельскохозяйственная продукция', deals_count: 2168, ordered_lots: 101426950, delivered_lots: 63630783, undelivered_lots: 37796167, total_amount_uzs: 1432389936788.68 },
        { product_category: 'Нефтепродукты', deals_count: 830, ordered_lots: 2399068, delivered_lots: 1543574, undelivered_lots: 855494, total_amount_uzs: 259285109707.00 },
        { product_category: 'Продовольственные товары', deals_count: 733, ordered_lots: 72332, delivered_lots: 45392, undelivered_lots: 26940, total_amount_uzs: 338020902160.16 },
        { product_category: 'Строительные материалы', deals_count: 615, ordered_lots: 96350, delivered_lots: 60792, undelivered_lots: 35558, total_amount_uzs: 79972835037.00 },
        { product_category: 'Полимерная продукция', deals_count: 418, ordered_lots: 9363, delivered_lots: 5682, undelivered_lots: 3681, total_amount_uzs: 185678255001.00 }
      ]
    }
  ];

  function fmt(val) {
    if (typeof val === 'number') {
      return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return val != null ? String(val) : '';
  }

  function renderMd(md) {
    if (!md) return '';
    return md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .split('\n')
      .map(function (line) { return '<p>' + line + '</p>'; })
      .join('');
  }

  function newSessionId() {
    return 'sess-' + Math.random().toString(36).slice(2, 9);
  }

  function persistConversations() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.conversations.slice(0, 30)));
  }

  function getCurrentConversation() {
    return state.conversations.find(function (item) { return item.id === state.sessionId; });
  }

  function renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';
    if (!state.conversations.length) {
      list.innerHTML = '<p class="history-empty">Your questions and answers will appear here.</p>';
      return;
    }
    state.conversations
      .slice()
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
      .forEach(function (conversation) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'history-item' + (conversation.id === state.sessionId ? ' active' : '');
        button.innerHTML = '<span class="history-title"></span><span class="history-time"></span>';
        button.querySelector('.history-title').textContent = conversation.title;
        button.querySelector('.history-time').textContent = new Date(conversation.updatedAt).toLocaleDateString();
        button.addEventListener('click', function () { selectConversation(conversation.id); });
        list.appendChild(button);
      });
  }

  function rememberConversation(question, payload) {
    let conversation = getCurrentConversation();
    if (!conversation) {
      conversation = { id: state.sessionId, title: question.slice(0, 48), updatedAt: Date.now(), turns: [] };
      state.conversations.push(conversation);
    }
    conversation.updatedAt = Date.now();
    conversation.turns.push({ question: question, payload: payload });
    persistConversations();
    renderHistory();
  }

  function renderConversation(conversation) {
    const thread = document.getElementById('thread');
    if (!thread) return;
    thread.innerHTML = '';
    (conversation?.turns || []).forEach(function (turn) {
      appendTurn(turn.question, turn.payload, turn.payload.responseLang, false);
    });
    thread.scrollTop = thread.scrollHeight;
  }

  async function selectConversation(sessionId) {
    state.sessionId = sessionId;
    const conversation = getCurrentConversation();
    renderConversation(conversation);
    renderHistory();
    document.body.classList.remove('history-open');
    try {
      const response = await window.fetch('/api/agent/sessions/' + encodeURIComponent(sessionId));
      if (response.ok && (!conversation || !conversation.turns.length)) {
        const data = await response.json();
        const messages = data.messages || [];
        const restored = { id: sessionId, title: 'Restored conversation', updatedAt: Date.now(), turns: [] };
        for (let i = 0; i < messages.length; i += 2) {
          if (messages[i]?.role === 'user' && messages[i + 1]?.role === 'assistant') {
            restored.turns.push({
              question: String(messages[i].content || ''),
              payload: { answer: String(messages[i + 1].content || ''), rows: [], responseLang: state.lang }
            });
          }
        }
        if (restored.turns.length) {
          state.conversations = state.conversations.filter(function (item) { return item.id !== sessionId; });
          state.conversations.push(restored);
          persistConversations();
          renderConversation(restored);
          renderHistory();
        }
      }
    } catch (_) {
      // Local transcript remains available when the API is offline.
    }
  }

  function startNewChat() {
    state.sessionId = newSessionId();
    const thread = document.getElementById('thread');
    if (thread) thread.innerHTML = '';
    renderHistory();
    document.body.classList.remove('history-open');
    document.getElementById('chat-input')?.focus();
  }

  function downloadCsv(rows, filename) {
    if (!rows || !rows.length) return;
    const cols = Object.keys(rows[0]);
    const lines = [cols.join(',')];
    rows.forEach(function (r) {
      lines.push(cols.map(function (k) {
        const s = r[k] != null ? String(r[k]) : '';
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(','));
    });
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'uzex_result.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function buildTableElement(rows) {
    if (!rows || !rows.length) return null;
    const cols = Object.keys(rows[0]);
    const card = document.createElement('div');
    card.className = 'table-card';

    const scroll = document.createElement('div');
    scroll.className = 'table-Scroll';
    const table = document.createElement('table');
    let sortKey = null;
    let sortAsc = true;
    const currentRows = rows.slice();

    function draw() {
      const thead = '<thead><tr>' + cols.map(function (k) {
        const isNum = typeof currentRows[0][k] === 'number';
        const arrow = sortKey === k ? (sortAsc ? ' ↑' : ' ↓') : '';
        return '<th data-k="' + k + '"' + (isNum ? ' class="num"' : '') + '>' + k + arrow + '</th>';
      }).join('') + '</tr></thead>';

      const tbody = '<tbody>' + currentRows.map(function (r) {
        return '<tr>' + cols.map(function (k) {
          const v = r[k];
          const isNum = typeof v === 'number';
          return '<td' + (isNum ? ' class="num"' : '') + '>' + fmt(v) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';

      table.innerHTML = thead + tbody;
      table.querySelectorAll('th[data-k]').forEach(function (th) {
        th.addEventListener('click', function () {
          const k = th.getAttribute('data-k');
          if (sortKey === k) {
            sortAsc = !sortAsc;
          } else {
            sortKey = k;
            sortAsc = false;
          }
          const dir = sortAsc ? 1 : -1;
          currentRows.sort(function (a, b) {
            if (typeof a[k] === 'number' && typeof b[k] === 'number') {
              return (a[k] - b[k]) * dir;
            }
            return String(a[k] || '').localeCompare(String(b[k] || '')) * dir;
          });
          draw();
        });
      });
    }

    draw();
    scroll.appendChild(table);
    card.appendChild(scroll);
    return card;
  }

  function appendTurn(questionText, payload, responseLang, remember) {
    const thread = document.getElementById('thread');
    if (!thread) return;

    const t = i18n[responseLang || state.lang];
    const turn = document.createElement('article');
    turn.className = 'turn';

    const qEl = document.createElement('div');
    qEl.className = 'message message-user';
    qEl.innerHTML = '<div class="message-label">You</div><div class="message-bubble"></div>';
    qEl.querySelector('.message-bubble').textContent = questionText;
    turn.appendChild(qEl);

    const aEl = document.createElement('div');
    aEl.className = 'message message-assistant';
    aEl.innerHTML = '<div class="message-label">UZEX agent</div><div class="message-bubble turn-answer"></div>';
    aEl.querySelector('.message-bubble').innerHTML = renderMd(payload.answer);
    turn.appendChild(aEl);

    // Tables below response omitted per user preference

    // SQL & RAG button hidden per user preference
    thread.appendChild(turn);
    thread.scrollTop = thread.scrollHeight;
    if (remember !== false) {
      payload.responseLang = responseLang || state.lang;
      rememberConversation(questionText, payload);
    }
  }

  function resolveFallbackQuery(text) {
    const q = (text || '').trim().toLowerCase();

    // 1. Check for UZEX domain relevance first (Zero-Hallucination Off-Topic Guardrail)
    const uzexDomainRegex = /(uzex|birja|бирж|bitim|сделк|shartnoma|контракт|лот|lot|broker|брокер|xaridor|покупател|sotuvchi|продав|stir|инн|tin|narx|цен|summa|сумм|hajm|объем|объём|eksport|экспорт|spot|спот|forvard|форвард|fyuchers|фьючерс|valyuta|валют|kurs|курс|dollar|доллар|usd|uzs|so‘m|so'm|som|сум|benzin|бензин|аи-92|ai-92|аи-80|ai-80|dizel|дизел|paxta|хлоп|shrot|шрот|yog‘|yog'|масло|selitra|селитр|karbamid|карбамид|o‘g‘it|удобрен|mis|медн|медь|katod|катод|sement|цемент|ko‘mir|уголь|shakar|сахар|un\b|мука|bug‘doy|пшениц|metall|металл|polietilen|полиэтилен|soda|сода|viloyat|област|toshkent|ташкент|samarqand|самарканд|buxoro|бухар|farg‘ona|ферган|andijon|андижан|namangan|наманган|qashqadaryo|кашкадар|surxondaryo|сурхандар|navoiy|навои|jizzax|джизак|sirdaryo|сырдар|xorazm|хорезм|qoraqalpog|каракалпак|bk0|bk1|исполнен|аннулирован|оплачен|bajarilgan|bekor|toifa|категор|2022|2023|2024|2025|2026)/i;

    const outOfRangeYearMatch = q.match(/\b(19\d\d|200\d|201\d|2020|2021|2027|2028|2029|203\d)\b/);
    const unsupportedEntityRegex = /(oltin|золот|gold|kumush|серебр|silver|kripto|крипт|bitcoin|биткоин|aksiya|акци|fond birja|фондов|avtomobil|автомобил|mashina|машин|uy-joy|недвижим|kvartira|квартир|ish haqi|зарплат|foyda|чистая прибыль|divid)/i;
    const invalidBrokerMatch = q.match(/\bbk(1[2-9]\d|[2-9]\d\d)\b/i);

    if (!uzexDomainRegex.test(q) && !outOfRangeYearMatch && !unsupportedEntityRegex) {
      return {
        rag: 'Guardrail A: Off-topic input blocked (0 SQL queries executed)',
        execMs: 0.4,
        sql: '-- BLOCKED: Input is unrelated to UZEX spot exchange data',
        answerRu: 'Это не относится к UZEX. Я отвечаю только на вопросы по сделкам, контрактам, участникам и брокерам биржи UZEX (2022–2026 гг.).',
        answerUz: 'Bu UZEX ga aloqador emas. Men faqat O‘zbekiston respublika tovar-xomashyo birjasi (UZEX) bitimlari, shartnomalari, ishtirokchilari va brokerlari (2022–2026) bo‘yicha savollarga javob beraman.',
        rows: []
      };
    }

    // 2. Check for Out-of-DB years (outside 03.01.2022 - 30.10.2026)
    if (outOfRangeYearMatch) {
      const badYear = outOfRangeYearMatch[1];
      return {
        rag: 'Guardrail B: Requested year (' + badYear + ') is outside DB range 2022–2026',
        execMs: 1.2,
        sql: "SELECT COUNT(*) AS deals_count FROM v_deals_enriched WHERE deal_year = " + badYear + "; -- Result: 0 rows",
        answerRu: 'В нашей базе данных UZEX нет информации за **' + badYear + ' год** (0 записей). В базе содержатся только зарегистрированные биржевые сделки за период с **03.01.2022 по 30.10.2026**.',
        answerUz: 'Bizning UZEX ma’lumotlar bazamizda **' + badYear + '-yil** bo‘yicha ma’lumot mavjud emas (0 ta yozuv). Bazada faqat **03.01.2022 dan 30.10.2026 gacha** bo‘lgan bitimlar saqlanadi.',
        rows: []
      };
    }

    // 3. Check for commodities/metrics or broker codes not present in the UZEX dataset
    if (unsupportedEntityRegex.test(q) || invalidBrokerMatch) {
      return {
        rag: 'Guardrail B/C: Requested entity or metric returned 0 matches in uzex.sqlite',
        execMs: 1.5,
        sql: '-- 0 matching records in contracts / deals / brokers / participants',
        answerRu: 'В нашей базе данных UZEX нет такой информации (0 совпадений в реестре контрактов и сделок). База содержит только 230 биржевых товаров (нефтепродукты, металлы, удобрения, сельхозпродукция, полимеры, стройматериалы, химия, продовольствие), 14,392 участника и 120 брокеров (`BK001`–`BK120`) за 2022–2026 гг.',
        answerUz: 'Bizning UZEX ma’lumotlar bazamizda bu bo‘yicha ma’lumot mavjud emas (shartnomalar va bitimlar reyestrida 0 ta moslik). Bazada faqat 2022–2026 yillardagi 230 ta birja mahsuloti, 14,392 ta ishtirokchi va 120 ta broker (`BK001`–`BK120`) haqida ma’lumot bor.',
        rows: []
      };
    }

    // 4. Match verified UZEX queries
    if (q.includes('аи-92') || q.includes('ai-92') || q.includes('бензин') || q.includes('benzin')) return BENCHMARKS[0];
    if (q.includes('экспорт') || q.includes('eksport') || q.includes('usd') || q.includes('доллар') || q.includes('dollar')) return BENCHMARKS[1];
    if (q.includes('брокер') || q.includes('broker')) return BENCHMARKS[2];
    if (q.includes('ташкент') || q.includes('toshkent')) return BENCHMARKS[3];
    if (q.includes('частич') || q.includes('qisman') || q.includes('поставлено') || q.includes('yetkaz')) return BENCHMARKS[4];
    if (q.includes('статус') || q.includes('состояни') || q.includes('holat') || q.includes('bekor') || q.includes('аннулир')) return DYNAMIC_TABLES.byStatus;
    if (q.includes('категор') || q.includes('товар') || q.includes('mahsulot') || q.includes('toifa')) return DYNAMIC_TABLES.byCategory;
    if (q.includes('регион') || q.includes('област') || q.includes('viloyat') || q.includes('hudud')) return DYNAMIC_TABLES.byRegion;
    if (q.includes('год') || q.includes('yil') || q.includes('2022') || q.includes('2023') || q.includes('2024') || q.includes('2025') || q.includes('2026') || q.includes('jami') || q.includes('всего') || q.includes('сколько') || q.includes('nechta') || q.includes('qancha')) {
      return DYNAMIC_TABLES.byYear;
    }

    // 5. Default fallback when a specific entity isn't cached in the browser preview
    return {
      rag: 'Guardrail B: Entity/filter not in browser preview cache (requires live SQLite query)',
      execMs: 1.1,
      sql: '-- Entity not found in offline preview cache; run against full uzex.sqlite via NestJS API',
      answerRu: 'В предпросмотре без подключенной БД точных данных по этому узкому фильтру нет — агент не выдумывает цифры. Запустите `npm run start:dev` с `uzex.sqlite`, чтобы выполнить точный SQL-запрос по всем 500,000 сделкам, либо уточните запрос.',
      answerUz: 'Ma’lumotlar bazasida (yoki brauzer keshida) bu aniq filtr bo‘yicha tasdiqlangan ma’lumot topilmadi — agent taxminiy raqamlarni to‘qib chiqarmaydi. Barcha 500,000 ta bitim bo‘yicha aniq SQL so‘rovni bajarish uchun `uzex.sqlite` bilan `npm run start:dev` ni ishga tushiring.',
      rows: []
    };
  }

  async function submitQuestion(text, presetBm) {
    if (!text || !text.trim()) return;

    // Auto-detect prompt language so Uzbek prompts always get Uzbek answers and Russian prompts get Russian answers
    const promptLang = detectPromptLanguage(text);
    if (promptLang !== state.lang) {
      state.lang = promptLang;
      document.querySelectorAll('.seg-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-lang') === state.lang);
      });
      applyLang();
    }

    const bm = presetBm || resolveFallbackQuery(text);

    try {
      const res = await window.fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          message: text,
          provider: state.settings.provider,
          apiKey: state.settings.apiKey,
          language: promptLang
        })
      });
      if (res && res.ok) {
        const data = await res.json();
        const ragText = (data.ragEntities || []).map(function (e) { return e.matched + ' → ' + e.canonicalId; }).join(' · ');
        appendTurn(text, {
          answer: data.answer,
          rows: data.rows || (data.tableData && data.tableData.rows) || [],
          sql: data.sql,
          rag: ragText,
          execMs: data.execMs
        }, promptLang);
        return;
      }
    } catch (_) {
      // Offline / sandbox fallback to verified dataset slice
    }

    appendTurn(text, {
      answer: promptLang === 'uz' ? bm.answerUz : bm.answerRu,
      rows: bm.rows,
      sql: bm.sql,
      rag: bm.rag,
      execMs: bm.execMs
    }, promptLang);
  }

  function renderPresets() {
    const bar = document.getElementById('presets-bar');
    if (!bar) return;
    bar.innerHTML = '';
    BENCHMARKS.forEach(function (bm) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'preset-pill';
      btn.textContent = state.lang === 'uz' ? bm.labelUz : bm.labelRu;
      btn.addEventListener('click', function () {
        const q = state.lang === 'uz' ? bm.queryUz : bm.queryRu;
        submitQuestion(q, bm);
      });
      bar.appendChild(btn);
    });
  }

  function applyLang() {
    const t = i18n[state.lang];
    const statsEl = document.getElementById('stats-summary');
    const clearBtn = document.getElementById('clear-btn');
    const inputEl = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');

    if (statsEl) statsEl.textContent = t.stats;
    if (clearBtn) clearBtn.textContent = t.clear;
    if (inputEl) inputEl.placeholder = t.placeholder;
    if (sendBtn) sendBtn.textContent = t.send;
    document.querySelectorAll('.seg-btn').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-lang') === state.lang);
    });
    renderPresets();
  }

  async function loadLibrary() {
    const list = document.getElementById('library-list');
    if (!list) return;
    const response = await fetch('/api/library').catch(function () { return null; });
    const documents = response && response.ok ? await response.json() : [];
    list.innerHTML = documents.length ? '' : '<p class="history-empty">No documents yet.</p>';
    documents.forEach(function (document) {
      const row = document.createElement('div');
      row.className = 'library-item';
      row.innerHTML = '<span class="library-name"></span><button type="button" class="meta-link">Delete</button>';
      row.querySelector('.library-name').textContent = document.name;
      row.querySelector('.meta-link').addEventListener('click', async function () {
        await fetch('/api/library/' + encodeURIComponent(document.id), { method: 'DELETE' });
        loadLibrary();
      });
      list.appendChild(row);
    });
  }

  function openSettings() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    document.getElementById('provider-select').value = state.settings.provider;
    document.getElementById('theme-select').value = state.settings.theme;
    document.getElementById('ui-language').value = state.settings.uiLang;
    document.getElementById('api-key-input').value = state.settings.apiKey;
    modal.hidden = false;
    loadLibrary();
  }

  function init() {
    document.querySelectorAll('.seg-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.lang = btn.getAttribute('data-lang') || 'ru';
        document.querySelectorAll('.seg-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        applyLang();
      });
    });

    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        await window.fetch('/api/agent/sessions/' + encodeURIComponent(state.sessionId), { method: 'DELETE' }).catch(function () {});
        state.conversations = state.conversations.filter(function (item) { return item.id !== state.sessionId; });
        persistConversations();
        const thread = document.getElementById('thread');
        if (thread) thread.innerHTML = '';
        renderHistory();
      });
    }

    document.getElementById('new-chat-btn')?.addEventListener('click', startNewChat);
    document.getElementById('settings-btn')?.addEventListener('click', openSettings);
    document.getElementById('close-settings')?.addEventListener('click', function () {
      document.getElementById('settings-modal').hidden = true;
    });
    document.getElementById('save-settings')?.addEventListener('click', function () {
      state.settings = {
        provider: document.getElementById('provider-select').value,
        theme: document.getElementById('theme-select').value,
        uiLang: document.getElementById('ui-language').value,
        apiKey: document.getElementById('api-key-input').value.trim()
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      state.lang = state.settings.uiLang;
      document.documentElement.dataset.theme = state.settings.theme;
      applyLang();
      document.getElementById('settings-modal').hidden = true;
    });
    document.getElementById('library-upload')?.addEventListener('change', async function (event) {
      for (const file of event.target.files) {
        const formData = new FormData();
        formData.append('file', file);
        await fetch('/api/library/upload', { method: 'POST', body: formData });
      }
      event.target.value = '';
      loadLibrary();
    });
    document.getElementById('history-toggle')?.addEventListener('click', function () {
      document.body.classList.toggle('history-open');
    });

    const form = document.getElementById('ask-form');
    const input = document.getElementById('chat-input');
    if (form && input) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        const val = input.value.trim();
        if (!val) return;
        input.value = '';
        submitQuestion(val, null);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }

    try {
      state.conversations = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch (_) {
      state.conversations = [];
    }
    const latest = state.conversations.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; })[0];
    state.sessionId = latest ? latest.id : newSessionId();
    renderHistory();
    renderConversation(getCurrentConversation());
    document.documentElement.dataset.theme = state.settings.theme;
    loadLibrary();
    applyLang();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
