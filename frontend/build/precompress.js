import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 构建产物预压缩:为文本产物写出 `.br` / `.gz` 同名兄弟文件,后端 @fastify/static
 * 以 `preCompressed: true` 直接发送,省掉运行时压缩与一次全量解压回源。
 *
 * 取舍(在真实 dist 上实测,46 个文本产物 / 5.32 MB):
 *  - brotli q11 1.186 MB 但耗时 9.0 s;q10 1.207 MB 耗时 3.3 s —— 多花 21 kB 换 5.7 s 构建时间,不值。
 *  - gzip(9) 1.475 MB 耗时 0.18 s,作为不支持 brotli 的客户端兜底。
 *  - <1 KB 的产物压缩后反而更大(压缩头开销),按 @fastify/static README 约定跳过。
 *  - `.map` 跳过:调试产物不进浏览器主路径,压缩它只拖慢构建。
 *  - 二进制(ttf/png)跳过:文本模式收益极低。
 */
export const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt']);
export const MIN_COMPRESS_BYTES = 1024;
export const BROTLI_QUALITY = 10;
const COMPRESS_CONCURRENCY = 4;

/** 递归收集需要预压缩的产物(跳过 .map、二进制与过小文件)。 */
export function collectCompressibleFiles(dir) {
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir)) return [];
  const targets = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.map')) continue;
      if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const stat = fs.statSync(full);
      if (stat.size < MIN_COMPRESS_BYTES) continue;
      targets.push({ file: full, size: stat.size });
    }
  };
  walk(absDir);
  return targets;
}

/**
 * 就地写出 `<file>.br` 与 `<file>.gz`。返回统计;压缩失败只告警不抛错,
 * 因为后端未压缩直发仍然可用,不该让一次压缩失败拖垮整条构建。
 */
export async function precompressAssets(dir) {
  const targets = collectCompressibleFiles(dir);
  if (!targets.length) return null;

  const brotliOptions = {
    [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
    [zlib.constants.BROTLI_PARAM_LARGE_WINDOW]: 1,
    [zlib.constants.BROTLI_MODE_TEXT]: 1,
  };
  const gzipOptions = { level: 9 };
  const totals = { files: targets.length, raw: 0, br: 0, gz: 0 };
  const queue = targets.map((target) => async () => {
    const source = fs.readFileSync(target.file);
    totals.raw += target.size;
    const br = await compress(zlib.brotliCompress, source, brotliOptions);
    fs.writeFileSync(`${target.file}.br`, br);
    totals.br += br.length;
    const gz = await compress(zlib.gzip, source, gzipOptions);
    fs.writeFileSync(`${target.file}.gz`, gz);
    totals.gz += gz.length;
  });

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const task = queue[cursor++];
      await task();
    }
  };
  const started = Date.now();
  try {
    await Promise.all(Array.from({ length: Math.min(COMPRESS_CONCURRENCY, queue.length) }, worker));
  } catch (error) {
    console.warn(`[precompress] 压缩失败,已跳过: ${error?.message || error}`);
    return null;
  }
  totals.ms = Date.now() - started;
  return totals;
}

function compress(fn, source, options) {
  return new Promise((resolve, reject) => {
    fn(source, options, (error, result) => (error ? reject(error) : resolve(result)));
  });
}
