/**
 * HTTP server for ReverseGen web GUI.
 *
 * Usage:
 *   npx tsx gui/server.ts [--host 0.0.0.0] [--port 3000] [--open]
 *
 * 本文件只保留服务骨架：基础路径处理、健康检查、静态文件与启动逻辑。
 * 各 API 域拆分到 gui/lib/ 下：
 *   lib/runtime.ts         共享状态与工具（地形解析、缓存、分档配置、HTTP 辅助）
 *   lib/strategy-admin.ts  生成策略管理辅助与处理器
 *   lib/api-generate.ts    生成/解码/回放分析类 API
 *   lib/api-analyze.ts     DAG 分析与可解性验证 API
 *   lib/api-simulate.ts    玩家模拟 API
 *   lib/api-run-sequence.ts 操作序列跑关（人工对照 Unity 的可读日志）
 *   lib/api-grade.ts       难度分档 API
 *   lib/api-batch.ts       批量生产与候选收集 API
 *   lib/api-strategy.ts    生成策略管理 API
 */

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setLogLevel, LogLevel } from '../src/index.js';
import {
  APP_NAME,
  APP_VERSION,
  GUI_DIR,
  defaultLevelsDir,
  listLevels,
  setDefaultLevelsDir,
  serveStatic,
  json,
  loadGradeConfig,
  loadGradeStrategy1Config,
} from './lib/runtime.js';
import {
  handleExternalGenerateReplay,
  handleMechanics,
  handleLevels,
  handleTerrainUpload,
  handleTerrainInfo,
  handleGenerate,
  handleDecode,
  handleReplayClosure,
  handleReplayParams,
  handleReplayCostlog,
} from './lib/api-generate.js';
import {
  handleAnalyzeTriples,
  handleTripleDetail,
  handleTileDag,
  handleEliminationPlan,
  handleDfsVerify,
} from './lib/api-analyze.js';
import {
  handlePlayerSim,
  handlePlayerSimShortest,
  handlePlayerSimRisky,
  handlePlayerSimCostcap,
  handlePlayerSimMistake,
} from './lib/api-simulate.js';
import { handleRunSequence } from './lib/api-run-sequence.js';
import {
  handleGradeConfig,
  handleGradeConfigReload,
  handleGradeCalculate,
  handleGradeValidate,
} from './lib/api-grade.js';
import {
  handleBatchStart,
  handleBatchStop,
  handleBatchStatus,
  handleBatchCsv,
  handleReplaySelectionAppend,
  handleReplaySelectionBuild,
} from './lib/api-batch.js';
import {
  handleStrategyMeta,
  handleStrategyList,
  handleStrategyValidate,
  handleStrategyCreate,
  handleGenerationRuns,
  handleStrategyHistory,
  handleStrategyItem,
} from './lib/api-strategy.js';

function normalizeBasePath(value: string | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}

const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH);
const frameAncestors = String(process.env.FRAME_ANCESTORS || '').trim();
const appSurface = String(process.env.APP_SURFACE || 'full').trim().toLowerCase() || 'full';

// ── CLI Args ──
const args = process.argv.slice(2);
let port = Number.parseInt(process.env.PORT || '', 10) || 3000;
let host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
let autoOpen = false;
let openPath = '/';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10); i++;
  } else if (args[i] === '--host' && args[i + 1]) {
    host = args[i + 1]; i++;
  } else if (args[i] === '--open') {
    autoOpen = true;
  } else if (args[i] === '--open-challenge') {
    autoOpen = true;
    openPath = '/challenge-expectation';
  } else if (args[i] === '--levels-dir' && args[i + 1]) {
    setDefaultLevelsDir(args[i + 1]); i++;
  }
}

setLogLevel(LogLevel.Silent);

// ── Server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const originalPath = url.pathname;
  const baseWithoutTrailingSlash = appBasePath === '/' ? '/' : appBasePath.slice(0, -1);

  if (frameAncestors) res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (appBasePath !== '/' && originalPath === baseWithoutTrailingSlash) {
    res.writeHead(302, { Location: appBasePath });
    res.end();
    return;
  }

  if (originalPath === '/health') {
    url.pathname = '/health';
  } else if (appBasePath !== '/') {
    if (!originalPath.startsWith(appBasePath)) {
      json(res, { ok: false, error: 'Not found' }, 404);
      return;
    }
    url.pathname = `/${originalPath.slice(appBasePath.length)}`;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    json(res, {
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      surface: appSurface,
      basePath: appBasePath,
      platformApiConfigured: Boolean(process.env.PLATFORM_API_URL),
    });
    return;
  }

  if (url.pathname === '/api/runtime-config' && req.method === 'GET') {
    json(res, {
      ok: true,
      surface: appSurface,
      basePath: appBasePath,
    });
    return;
  }

  // ── 外部生成接口 ──
  if (await handleExternalGenerateReplay(req, res, url)) return;

  // ── 机制注册表 ──
  if (await handleMechanics(req, res, url)) return;

  // ── 生成策略管理 ──
  if (await handleStrategyMeta(req, res, url)) return;
  if (await handleStrategyList(req, res, url)) return;
  if (await handleStrategyValidate(req, res, url)) return;
  if (await handleStrategyCreate(req, res, url)) return;
  if (await handleGenerationRuns(req, res, url)) return;
  if (await handleStrategyHistory(req, res, url)) return;
  if (await handleStrategyItem(req, res, url)) return;

  // ── 地形加载与生成 ──
  if (await handleLevels(req, res, url)) return;
  if (await handleTerrainUpload(req, res, url)) return;
  if (await handleTerrainInfo(req, res, url)) return;
  if (await handleGenerate(req, res, url)) return;
  if (await handleDecode(req, res, url)) return;
  if (await handleReplayClosure(req, res, url)) return;
  if (await handleReplayParams(req, res, url)) return;
  if (await handleReplayCostlog(req, res, url)) return;

  // ── 分析 ──
  if (await handleAnalyzeTriples(req, res, url)) return;
  if (await handleTripleDetail(req, res, url)) return;
  if (await handleTileDag(req, res, url)) return;
  if (await handleEliminationPlan(req, res, url)) return;
  if (await handleDfsVerify(req, res, url)) return;

  // ── 玩家模拟 ──
  if (await handlePlayerSim(req, res, url)) return;
  if (await handlePlayerSimShortest(req, res, url)) return;
  if (await handlePlayerSimRisky(req, res, url)) return;
  if (await handlePlayerSimCostcap(req, res, url)) return;
  if (await handlePlayerSimMistake(req, res, url)) return;

  // ── 操作序列跑关（人工对照 Unity 的可读日志） ──
  if (await handleRunSequence(req, res, url)) return;

  // ── 分档 ──
  if (await handleGradeConfig(req, res, url)) return;
  if (await handleGradeConfigReload(req, res, url)) return;
  if (await handleGradeCalculate(req, res, url)) return;
  if (await handleGradeValidate(req, res, url)) return;

  // ── 批量生产与候选收集 ──
  if (await handleBatchStart(req, res, url)) return;
  if (await handleBatchStop(req, res, url)) return;
  if (await handleBatchStatus(req, res, url)) return;
  if (await handleBatchCsv(req, res, url)) return;
  if (await handleReplaySelectionAppend(req, res, url)) return;
  if (await handleReplaySelectionBuild(req, res, url)) return;

  // ── Static files ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStatic(res, join(GUI_DIR, 'index.html'));
    return;
  }
  if (appSurface === 'generator') {
    if (url.pathname === '/reversegen-theme.js' || url.pathname === '/reversegen-theme.css') {
      serveStatic(res, join(GUI_DIR, url.pathname));
      return;
    }
    json(res, { ok: false, error: 'Not found' }, 404);
    return;
  }
  if (url.pathname === '/challenge-expectation' || url.pathname === '/challenge-expectation/') {
    serveStatic(res, join(GUI_DIR, 'challenge-expectation', 'index.html'));
    return;
  }
  if (url.pathname === '/batch-generate.html' || url.pathname === '/batch-generate') {
    serveStatic(res, join(GUI_DIR, 'batch-generate.html'));
    return;
  }
  if (url.pathname === '/generation-strategies.html' || url.pathname === '/generation-strategies') {
    serveStatic(res, join(GUI_DIR, 'generation-strategies.html'));
    return;
  }
  serveStatic(res, join(GUI_DIR, url.pathname));
});

server.listen(port, host, () => {
  // 启动时加载分档配置
  try { loadGradeConfig(); } catch (e) { console.warn(`⚠️  分档配置加载失败: ${e}`); }
  try { loadGradeStrategy1Config(); } catch (e) { console.warn(`⚠️  分档策略1配置加载失败: ${e}`); }

  console.log(`\n🔧 ReverseGen GUI → http://localhost:${port}${appBasePath}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    const virtualInterfacePattern = /(?:vEthernet|WSL|Hyper-V|VMware|VirtualBox|VMnet|Docker|TAP|VPN|Loopback|Bluetooth|蓝牙)/i;
    const addresses = Object.entries(networkInterfaces())
      .flatMap(([interfaceName, entries]) => (entries ?? [])
        .filter(entry => entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.'))
        .map(entry => ({
          interfaceName,
          address: entry.address,
          virtual: virtualInterfacePattern.test(interfaceName),
        })))
      .filter((item, index, all) => all.findIndex(other => other.address === item.address) === index);
    const physicalAddresses = addresses.filter(item => !item.virtual);
    const virtualAddresses = addresses.filter(item => item.virtual);

    if (physicalAddresses.length) {
      console.log('🌐 局域网访问（请选择与访问设备处于同一网络的地址）:');
      for (const item of physicalAddresses) {
        console.log(`   http://${item.address}:${port}  [${item.interfaceName}]`);
      }
    } else {
      console.log('⚠️  未检测到可用的物理局域网地址');
    }
    if (virtualAddresses.length) {
      console.log('🧩 虚拟网卡地址（通常仅供 WSL、虚拟机或 VPN 内部访问）:');
      for (const item of virtualAddresses) {
        console.log(`   http://${item.address}:${port}  [${item.interfaceName}]`);
      }
    }
  }
  if (existsSync(defaultLevelsDir)) {
    const n = listLevels(defaultLevelsDir).length;
    console.log(`📁 ReplayCode 自动匹配目录（兼容功能）: ${defaultLevelsDir} (${n} 个关卡)`);
  } else {
    console.log('ℹ️  未配置 ReplayCode 自动匹配目录；手动选择地形文件不受影响');
  }
  console.log('');
  if (autoOpen) {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    const baseUrl = `http://localhost:${port}${appBasePath}`;
    const target = openPath === '/' ? baseUrl : `${baseUrl}${openPath.replace(/^\//, '')}`;
    exec(`${cmd} ${target}`);
  }
});
