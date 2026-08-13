/**
 * GUI 策略管理 — generation-strategies 的目录读写、目录/校验/计划/历史
 * 等辅助函数与 API 处理器。
 */

import { existsSync, readdirSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { StrategyDefinition } from '../../src/strategy/types.js';
import { validateStrategyDefinition } from '../../src/strategy/definition.js';
import { compileEditorStrategyV2, strategyV2ToEditor, type StrategyEditorMeta } from '../../src/strategy/web-adapter.js';
import {
  GENERATION_CATALOG_PATH,
  GENERATION_RUNS_DIR,
  GENERATION_SCHEMA_PATH,
  GENERATION_STRATEGIES_DIR,
  GENERATION_STRATEGY_ID,
  writeJsonAtomic,
} from './runtime.js';

export type GenerationStrategy = Record<string, any>;

export { writeJsonAtomic } from './runtime.js';

export function generationStrategyPath(strategyId: string): string {
  if (!GENERATION_STRATEGY_ID.test(strategyId)) throw new Error('策略 ID 仅允许小写字母、数字、下划线和连字符');
  return join(GENERATION_STRATEGIES_DIR, strategyId, 'strategy.v2.json');
}

export function generationStrategyUiPath(strategyId: string): string {
  generationStrategyPath(strategyId);
  return join(GENERATION_STRATEGIES_DIR, strategyId, 'ui.json');
}

export function readStrategyUiMeta(strategyId: string): StrategyEditorMeta {
  const path = generationStrategyUiPath(strategyId);
  return existsSync(path) ? readJsonFile<StrategyEditorMeta>(path) : {};
}

export function editorMeta(strategy: GenerationStrategy): StrategyEditorMeta {
  return {
    name: String(strategy.meta?.name || strategy.meta?.strategy_id || ''),
    status: String(strategy.meta?.status || 'active'),
    notes: String(strategy.meta?.notes || ''),
  };
}

export function readJsonFile<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

export function readGenerationCatalog(): any {
  const catalog = readJsonFile<any>(GENERATION_CATALOG_PATH);
  const groups = catalog.fieldGroups || {};
  const generators = catalog.generators || {};
  const modes = catalog.policyModes || {};
  const policyFields = new Set(['value', 'ratio', 'jitter', 'min', 'max', 'points']);
  const reachableFields = new Map<string, Set<string>>(
    Object.keys(groups).map(group => [group, new Set<string>()]),
  );
  const reachableModes = new Set<string>();
  if (!catalog.workflows || !Object.keys(catalog.workflows).length) throw new Error('页面能力目录缺少 workflows');
  for (const [group, fieldIds] of Object.entries<any>(catalog.commonFields || {})) {
    if (!groups[group]) throw new Error(`通用配置引用了未知字段组 ${group}`);
    for (const fieldId of fieldIds || []) {
      if (!groups[group].includes(fieldId)) throw new Error(`通用配置引用了未知字段 ${group}.${fieldId}`);
      reachableFields.get(group)?.add(fieldId);
    }
  }
  for (const [workflowId, workflow] of Object.entries<any>(catalog.workflows)) {
    for (const section of workflow.sections || []) {
      if (section !== 'generation' && !groups[section]) throw new Error(`工作流 ${workflowId} 引用了未知模块 ${section}`);
    }
    for (const [group, fieldIds] of Object.entries<any>(workflow.fields || {})) {
      if (!groups[group]) throw new Error(`工作流 ${workflowId} 引用了未知字段组 ${group}`);
      for (const fieldId of fieldIds || []) {
        if (!groups[group].includes(fieldId)) throw new Error(`工作流 ${workflowId} 引用了未知字段 ${group}.${fieldId}`);
        reachableFields.get(group)?.add(fieldId);
      }
    }
    for (const generatorId of workflow.supportedGenerators || []) {
      if (!generators[generatorId]) throw new Error(`工作流 ${workflowId} 引用了未知生成器 ${generatorId}`);
    }
  }
  for (const [generatorId, generator] of Object.entries<any>(generators)) {
    for (const policy of generator.policies || []) {
      if (!generator.policyModes?.[policy]) throw new Error(`生成器 ${generatorId} 缺少 ${policy} 的 mode 列表`);
      for (const mode of generator.policyModes[policy]) {
        if (!modes[mode]) throw new Error(`生成器 ${generatorId}.${policy} 引用了未知 mode ${mode}`);
        reachableModes.add(mode);
      }
    }
  }
  for (const [group, fieldIds] of Object.entries<any>(groups)) {
    for (const fieldId of fieldIds || []) {
      if (!reachableFields.get(group)?.has(fieldId)) throw new Error(`配置项 ${group}.${fieldId} 没有可选择的工作流入口`);
    }
  }
  for (const [mode, definition] of Object.entries<any>(modes)) {
    if (!reachableModes.has(mode)) throw new Error(`参数 mode ${mode} 没有可选择的生成器入口`);
    for (const field of definition.fields || []) {
      if (!policyFields.has(field)) throw new Error(`参数 mode ${mode} 引用了未知输入字段 ${field}`);
    }
  }
  const batchWorkflow = catalog.workflows['run-batch-generation'];
  batchWorkflow.supportedGenerators = ['layer-closure'];
  batchWorkflow.fields.evaluation = ['gradeStrategy', 'simRuns', 'simulationEngine', 'thresholdProfile', 'collectTrace', 'traceSampleRate', 'optimalRuns', 'optimalEnabled', 'optimalWrap'];
  batchWorkflow.fields.search = ['attemptsPerLevel', 'concurrency', 'strategySeed'];
  batchWorkflow.fields.outputs = ['outputDirectory', 'writeConfig'];
  catalog.workflows = { 'run-batch-generation': batchWorkflow };
  catalog.generators = { 'layer-closure': catalog.generators['layer-closure'] };
  catalog.generators['layer-closure'].policyModes.closure = ['random', 'random_range', 'per_layer_list'];
  return catalog;
}


export function strategySummary(strategy: StrategyDefinition, path: string, ui: StrategyEditorMeta = {}) {
  const target = strategy.target || {};
  return {
    strategyId: strategy.id || basename(path, '.v2.json'),
    name: String(ui.name || strategy.id),
    version: strategy.version,
    purpose: String(strategy.description || ''),
    status: String(ui.status || 'active'),
    executor: 'run-batch-generation',
    grades: Array.isArray(target.grades) ? target.grades : [],
    targetCount: Number(target.count_per_grade || 0),
    sourceCsv: '',
    updatedAt: statSync(path).mtime.toISOString(),
  };
}

export function listGenerationStrategies() {
  mkdirSync(GENERATION_STRATEGIES_DIR, { recursive: true });
  return readdirSync(GENERATION_STRATEGIES_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && GENERATION_STRATEGY_ID.test(entry.name))
    .map(entry => {
      const path = generationStrategyPath(entry.name);
      if (!existsSync(path)) return null;
      try {
        const strategy = validateStrategyDefinition(readJsonFile(path));
        return strategySummary(strategy, path, readStrategyUiMeta(strategy.id));
      }
      catch (error) {
        return {
          strategyId: entry.name, name: entry.name, version: 0,
          purpose: String(error), status: 'invalid', executor: '', grades: [], targetCount: 0,
          sourceCsv: '', updatedAt: statSync(path).mtime.toISOString(),
        };
      }
    })
    .filter((item): item is Exclude<typeof item, null> => item !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function historyStamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace('Z', '').replace('.', '_');
}

export function writeGenerationStrategySnapshot(
  strategy: StrategyDefinition,
  ui: StrategyEditorMeta,
  reason: string,
  stableName = false,
): void {
  const id = strategy.id;
  const version = strategy.version;
  const dir = join(GENERATION_STRATEGIES_DIR, id, 'versions');
  mkdirSync(dir, { recursive: true });
  const suffix = stableName ? 'baseline' : historyStamp();
  const path = join(dir, `v${version}_${suffix}.json`);
  if (stableName && existsSync(path)) return;
  writeJsonAtomic(path, { recordedAt: new Date().toISOString(), reason, strategy, ui });
}

export function listGenerationStrategyHistory(strategyId: string) {
  generationStrategyPath(strategyId);
  const dir = join(GENERATION_STRATEGIES_DIR, strategyId, 'versions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const value = readJsonFile<any>(join(dir, name));
      const strategy = validateStrategyDefinition(value.strategy || value);
      const ui = value.ui ?? readStrategyUiMeta(strategy.id);
      const editor = strategyV2ToEditor(strategy, ui);
      return {
        file: name,
        recordedAt: value.recordedAt || statSync(join(dir, name)).mtime.toISOString(),
        reason: value.reason || 'history',
        version: strategy.version,
        name: String(ui.name || strategy.id),
        status: String(ui.status || 'active'),
        strategy: editor,
      };
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export async function validateGenerationStrategy(strategy: GenerationStrategy): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  try {
    compileEditorStrategyV2(strategy);
    return { ok: true, errors: [], warnings: [] };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] };
  }
}

export async function planGenerationStrategy(strategyPath: string, strategyId: string): Promise<any> {
  const strategy = validateStrategyDefinition(readJsonFile(strategyPath));
  return {
    schema_version: 2,
    strategy: { id: strategy.id, version: strategy.version, file: strategyPath },
    output_root: join(GENERATION_RUNS_DIR, strategy.id),
    command: `npm run strategy:run -- --strategy ${strategyPath}`,
    levels: strategy.scope.levels.length,
    max_attempts_per_level: strategy.target.max_attempts_per_level,
    strategyId,
  };
}

export function refreshGenerationStrategyIndex(): void {
  // strategy v2 files in /strategies are the index; no generated legacy index is needed.
}

export function listGenerationRuns() {
  if (!existsSync(GENERATION_RUNS_DIR)) return [];
  const summaries = new Map(listGenerationStrategies().map(item => [item.strategyId, item]));
  return readdirSync(GENERATION_RUNS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(strategyEntry => readdirSync(join(GENERATION_RUNS_DIR, strategyEntry.name), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(runEntry => {
        try {
          const outputDir = join(GENERATION_RUNS_DIR, strategyEntry.name, runEntry.name);
          const manifestPath = join(outputDir, 'manifest.json');
          if (!existsSync(manifestPath)) return null;
          const manifest = readJsonFile<any>(manifestPath);
          const artifacts = manifest.artifacts ?? {};
          const snapshotPath = join(outputDir, artifacts.strategy_snapshot ?? 'strategy.snapshot.json');
          return {
            runId: String(manifest.run_id ?? runEntry.name),
            strategyId: String(manifest.strategy?.id ?? strategyEntry.name),
            strategyName: summaries.get(strategyEntry.name)?.name ?? strategyEntry.name,
            strategyVersion: Number(manifest.strategy?.version ?? 0),
            status: manifest.status === 'complete' ? 'done' : String(manifest.status ?? 'planned'),
            createdAt: String(manifest.created_at ?? statSync(manifestPath).birthtime.toISOString()),
            updatedAt: String(manifest.updated_at ?? statSync(manifestPath).mtime.toISOString()),
            artifacts: {
              directory: outputDir,
              records: join(outputDir, artifacts.records ?? 'records.jsonl'),
              accepted: join(outputDir, artifacts.accepted ?? 'accepted.jsonl'),
              status: join(outputDir, artifacts.status ?? 'status.json'),
            },
            strategySnapshot: existsSync(snapshotPath) ? readJsonFile(snapshotPath) : undefined,
          };
        } catch { return null; }
      }))
    .filter(Boolean)
    .sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

