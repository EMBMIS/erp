#!/usr/bin/env node
/**
 * One-time / periodic backfill for document_embeddings (migration 126) — the
 * free-text chunk+embedding table behind services/ai/documentSearch.js and
 * the RAG context injected into AI chat (services/ai/ragRetrieval.js).
 *
 * Covers every source type that feeds it: knowledge base documents
 * (kb_documents), sales contracts, generated documents, and chat messages.
 * Each already has its own bulk indexer (indexSalesContracts,
 * indexGeneratedDocuments, indexConversationMessages) reused here rather than
 * reimplemented — this script's job is just to run all of them and report one
 * combined summary. Safe to re-run: each indexer replaces a document's
 * existing chunks rather than duplicating them.
 *
 * Usage:
 *   node backend/scripts/backfill-document-embeddings.js
 */

const { pool } = require('../config/database');
const documentSearch = require('../services/ai/documentSearch');
const knowledgeBase = require('../services/ai/knowledgeBase');

async function main() {
  console.log('Backfilling document embeddings...\n');

  const [kb, contracts, generated, chatMessages] = await Promise.all([
    knowledgeBase.indexPending({ limit: 2000 }),
    documentSearch.indexSalesContracts({ limit: 2000 }),
    documentSearch.indexGeneratedDocuments({ limit: 2000 }),
    documentSearch.indexConversationMessages({ limit: 2000 }),
  ]);

  console.log(`kb_documents:        ${kb.indexed}/${kb.total} indexed, ${kb.skipped} skipped`);
  console.log(`sales_contracts:     ${contracts.indexed}/${contracts.total} indexed, ${contracts.skipped} skipped`);
  console.log(`generated_documents: ${generated.indexed}/${generated.total} indexed, ${generated.skipped} skipped`);
  console.log(`chat_messages:       ${chatMessages.indexed}/${chatMessages.total} indexed, ${chatMessages.skipped} skipped`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Backfill failed:', err);
    pool.end();
    process.exitCode = 1;
  });
