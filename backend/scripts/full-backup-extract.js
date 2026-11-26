import path from 'node:path';
import { readFile, mkdir, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { decryptArtifact, digestFile } from '../src/services/maintenance-archive.js';

/** 只解密到全新的隔离目录，不写回原路径，不启动/停止任何容器。 */
export async function extractFullBackup(source, keyFile, destination) {
  const key = await readFile(keyFile);
  if (key.length !== 32) throw new Error('恢复密钥必须为原始 32 字节文件');
  const receipt = JSON.parse(await readFile(path.join(source, 'receipt.json'), 'utf8'));
  if (
    receipt.complete !== true ||
    receipt.type !== 'full' ||
    !Array.isArray(receipt.artifacts) ||
    !receipt.artifacts.length
  )
    throw new Error('该目录不是已完成的完整备份');
  const files = new Set();
  for (const item of receipt.artifacts) {
    if (!/^[\w.-]+\.enc$/.test(item.file) || files.has(item.file))
      throw new Error('备份清单文件名无效或重复');
    files.add(item.file);
    const file = path.join(source, item.file),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== item.bytes ||
      (await digestFile(file)) !== item.sha256
    )
      throw new Error('密文文件校验失败：' + item.file);
  }
  const manifestItem = receipt.artifacts.find(
    (item) => item.kind === 'manifest' && item.file === 'manifest.json.enc',
  );
  if (!manifestItem) throw new Error('缺少加密恢复清单');
  try {
    await lstat(destination);
    throw new Error('输出目录已存在，拒绝覆盖');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const staging = destination + '.partial-' + randomUUID();
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const item of receipt.artifacts)
      await decryptArtifact(
        path.join(source, item.file),
        key,
        createWriteStream(path.join(staging, item.file.slice(0, -4)), { flags: 'wx', mode: 0o600 }),
      );
    const manifest = JSON.parse(await readFile(path.join(staging, 'manifest.json'), 'utf8'));
    if (
      manifest.id !== receipt.id ||
      manifest.type !== 'full' ||
      manifest.artifacts.length + 1 !== receipt.artifacts.length
    )
      throw new Error('完整清单与备份批次不一致');
    for (const item of manifest.artifacts)
      if (
        !receipt.artifacts.some(
          (entry) => entry.file === item.file && entry.sha256 === item.sha256 && entry.bytes === item.bytes,
        )
      )
        throw new Error('恢复清单缺少必需产物');
    const guide = [
      '# 完整备份已解密并验证',
      '',
      'manifest.json 包含原始容器 Config/HostConfig、镜像快照映射、所有挂载及项目模型。该文件含敏感配置，应限制访问。',
      '',
      '1. 在隔离 Docker 环境加载 image-*.tar 和 rootfs-*.tar。rootfs 为含可写层变化的完整镜像。',
      '2. 按 manifest.artifacts 中 source 和 archiveRoot 映射，将 source-*.tar 解包到新建测试目录/数据卷。使用 GNU tar --acls --xattrs --numeric-owner 保留元数据。',
      '3. 参照 manifest.projects 的原始编排、manifest.containers 的精确启动配置和快照镜像 ID，在隔离网络与新端口重建。',
      '4. 验证应用、数据库读写、文件权限和数据数量后，再安排人工恢复到原环境。',
      '',
      '本脚本没有写回原应用路径，没有启动或停止容器；文件校验通过不能替代应用恢复演练。',
    ];
    await writeFile(path.join(staging, 'RECOVERY.md'), guide.join('\n'), { mode: 0o600 });
    await rename(staging, destination);
    return { id: receipt.id, files: receipt.artifacts.length, destination };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , source, key, destination] = process.argv;
  if (!source || !key || !destination)
    throw new Error(
      '用法：node backend/scripts/full-backup-extract.js <备份批次目录> <恢复密钥文件> <不存在的隔离输出目录>',
    );
  console.log(
    JSON.stringify(
      await extractFullBackup(path.resolve(source), path.resolve(key), path.resolve(destination)),
    ),
  );
}
