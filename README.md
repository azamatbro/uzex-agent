# UZEX AI Agent

This is my submission for the UZEX AI hackathon selection process.

The project is a small web application for exploring UZEX spot-market data from 2022–2026. You can ask questions in Uzbek, Russian, or English, and the agent combines entity search, read-only SQL, and a document library to produce answers from the available data. Results can also be shown as sortable tables and exported as CSV.

## What it includes

- NestJS and TypeScript backend
- SQLite database built from the UZEX CSV dataset
- Hybrid Text-to-SQL and RAG workflow
- Uzbek/Russian entity matching for products, regions, companies, and brokers
- Browser chat history
- Local document library for PDF, DOCX, CSV, and Excel files
- Gemini, OpenAI, and DeepSeek provider settings

## Run locally

Install dependencies:

```bash
npm install
```

Build the SQLite database from the included CSV files:

```bash
npm run ingest
```

Start the application:

```bash
npm run start:dev
```

Open [http://localhost:3000](http://localhost:3000).

## LLM setup

You can enter an `LLM_api_key` in the Settings panel. The key is kept in the browser and sent with chat requests; it is not saved in the project.

For server-side configuration, copy [.env.example](./.env.example) to `.env` or export the variables in your shell. Never commit a real key.

## Data

The source CSV files are in [uzex_spot_data](./uzex_spot_data). The included dataset covers deals, contracts, participants, brokers, and daily USD rates. The generated SQLite file is intentionally ignored because it can be rebuilt with `npm run ingest`.
