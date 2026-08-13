/**
 * GUI 生成策略 API：策略目录/元信息、列表、校验、创建、运行列表、
 * 历史与单策略读写。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { validateStrategyDefinition } from '../../src/strategy/definition.js';
import { compileEditorStrategyV2, strategyV2ToEditor } from '../../src/strategy/web-adapter.js';
import { GENERATION_SCHEMA_PATH, json, parseBody } from './runtime.js';
import {
  editorMeta,
  generationStrategyPath,
  generationStrategyUiPath,
  listGenerationRuns,
  listGenerationStrategies,
  listGenerationStrategyHistory,
  planGenerationStrategy,
  readGenerationCatalog,
  readJsonFile,
  readStrategyUiMeta,
  refreshGenerationStrategyIndex,
  strategySummary,
  validateGenerationStrategy,
  writeGenerationStrategySnapshot,
  writeJsonAtomic,
  type GenerationStrategy,
} from './strategy-admin.js';

export async function handleStrategyMeta(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/generation-strategies/meta' || req.method !== 'GET') return false;
    try {
      const catalog = readGenerationCatalog();
      const layerClosure = catalog.generators?.['layer-closure'] || {};
      json(res, {
        ok: true,
        schema: readJsonFile(GENERATION_SCHEMA_PATH),
        catalog,
        options: {
          executors: Object.entries(catalog.workflows || {}).map(([value, item]: [string, any]) => [value, item.label]),
          closureModes: layerClosure.policyModes?.closure || [],
          colorModes: layerClosure.policyModes?.color || [],
          colorAllocationModes: layerClosure.policyModes?.color_allocation || [],
          scalarModes: layerClosure.policyModes?.spread || [],
          statuses: ['draft', 'active', 'deprecated', 'archived'],
          fillPolicies: ['all'],
          fallbackPolicies: ['none'],
        },
      });
    } catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return true;
  }

export async function handleStrategyList(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/generation-strategies' || req.method !== 'GET') return false;
    try { json(res, { ok: true, strategies: listGenerationStrategies() }); }
    catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return true;
  }

export async function handleStrategyValidate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/generation-strategies/validate' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    const strategy = body.strategy as GenerationStrategy;
    if (!strategy || typeof strategy !== 'object') { json(res, { ok: false, errors: ['缺少 strategy 对象'], warnings: [] }, 400); return true; }
    json(res, await validateGenerationStrategy(strategy));
    return true;
  }

export async function handleStrategyCreate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/generation-strategies' || req.method !== 'POST') return false;
    const body = await parseBody(req);
    try {
      const editor = JSON.parse(JSON.stringify(body.strategy || {})) as GenerationStrategy;
      const strategyId = String(editor.meta?.strategy_id || '');
      const path = generationStrategyPath(strategyId);
      if (existsSync(path)) { json(res, { ok: false, error: `策略 ${strategyId} 已存在，请使用复制后的新 ID` }, 409); return true; }
      editor.meta.version = 1;
      const validation = await validateGenerationStrategy(editor);
      if (!validation.ok) { json(res, validation, 422); return true; }
      const strategy = compileEditorStrategyV2(editor);
      const ui = editorMeta(editor);
      writeJsonAtomic(path, strategy);
      writeJsonAtomic(generationStrategyUiPath(strategyId), ui);
      writeGenerationStrategySnapshot(strategy, ui, 'created');
      const plan = await planGenerationStrategy(path, strategyId);
      refreshGenerationStrategyIndex();
      const response = strategyV2ToEditor(strategy, ui);
      json(res, { ok: true, strategy: response, validation, plan, summary: strategySummary(strategy, path, ui) }, 201);
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handleGenerationRuns(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/api/generation-runs' || req.method !== 'GET') return false;
    try { json(res, { ok: true, runs: listGenerationRuns() }); }
    catch (err) { json(res, { ok: false, error: String(err) }, 500); }
    return true;
  }

export async function handleStrategyHistory(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const strategyHistoryMatch = url.pathname.match(/^\/api\/generation-strategies\/([^/]+)\/history$/);
  if (!strategyHistoryMatch || req.method !== 'GET') return false;
    try {
      const strategyId = decodeURIComponent(strategyHistoryMatch[1]);
      json(res, { ok: true, history: listGenerationStrategyHistory(strategyId) });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }

export async function handleStrategyItem(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const strategyItemMatch = url.pathname.match(/^\/api\/generation-strategies\/([^/]+)$/);
  if (!strategyItemMatch) return false;
  if (req.method === 'GET') {
    try {
      const strategyId = decodeURIComponent(strategyItemMatch[1]);
      const path = generationStrategyPath(strategyId);
      if (!existsSync(path)) { json(res, { ok: false, error: '策略不存在' }, 404); return true; }
      const strategy = validateStrategyDefinition(readJsonFile(path));
      const ui = readStrategyUiMeta(strategyId);
      json(res, { ok: true, strategy: strategyV2ToEditor(strategy, ui), summary: strategySummary(strategy, path, ui) });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }
  if (req.method === 'PUT') {
    const body = await parseBody(req);
    try {
      const strategyId = decodeURIComponent(strategyItemMatch[1]);
      const path = generationStrategyPath(strategyId);
      if (!existsSync(path)) { json(res, { ok: false, error: '策略不存在' }, 404); return true; }
      const previous = validateStrategyDefinition(readJsonFile(path));
      const previousUi = readStrategyUiMeta(strategyId);
      const editor = JSON.parse(JSON.stringify(body.strategy || {})) as GenerationStrategy;
      if (String(editor.meta?.strategy_id || '') !== strategyId) throw new Error('更新时不能修改策略 ID，请使用复制策略');
      writeGenerationStrategySnapshot(previous, previousUi, 'baseline before first visual edit', true);
      editor.meta.version = previous.version + 1;
      const validation = await validateGenerationStrategy(editor);
      if (!validation.ok) { json(res, validation, 422); return true; }
      const strategy = compileEditorStrategyV2(editor);
      const ui = editorMeta(editor);
      writeJsonAtomic(path, strategy);
      writeJsonAtomic(generationStrategyUiPath(strategyId), ui);
      writeGenerationStrategySnapshot(strategy, ui, 'updated');
      const plan = await planGenerationStrategy(path, strategyId);
      refreshGenerationStrategyIndex();
      const response = strategyV2ToEditor(strategy, ui);
      json(res, { ok: true, strategy: response, validation, plan, summary: strategySummary(strategy, path, ui) });
    } catch (err) { json(res, { ok: false, error: String(err) }, 400); }
    return true;
  }
  return false;
}
