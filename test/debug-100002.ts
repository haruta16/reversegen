import { loadTerrainFromFile } from '../src/terrain-loader.js';
import { searchDeath } from '../src/dag-death.js';
import { setLogLevel, LogLevel } from '../src/logger.js';
setLogLevel(LogLevel.Error);
import { join } from 'node:path';

const D='E:/workspace/tilematch/TileMatchShell/Tools/Config/Json/Levels';
const t=loadTerrainFromFile(join(D,'100002.json'));
console.log('Loaded');
const r=searchDeath(t);
console.log('success:',r.success,'deathStep:',r.deathStep);
console.log('reason:',r.reason);
console.log('planColors:',r.planColors,'deathColors:',r.deathColors);
