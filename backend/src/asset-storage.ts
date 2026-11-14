import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { checksum, MAX_UPLOAD_BYTES, type AssetMime } from './asset-validation.js';

export type StorageBackend = 'local' | 's3';
export type ConditionalRemoval = 'removed' | 'missing' | 'mismatch';
export interface AssetStore {
  readonly mode: StorageBackend;
  put(key: string, bytes: Buffer, mime: AssetMime, attemptMarker?: string): Promise<void>;
  read(backend: StorageBackend, key: string, size: number, expectedChecksum: string): Promise<Buffer>;
  remove(backend: StorageBackend, key: string): Promise<void>;
  removeConditional(backend: StorageBackend, key: string, expectedChecksum: string, attemptMarker: string): Promise<ConditionalRemoval>;
  close(): void;
}
const keyPattern = /^rst_[A-Za-z0-9_-]{24}\/ast_[A-Za-z0-9_-]{24}\.(pdf|jpg|png)$/;
function validKey(key: string): void { if (!keyPattern.test(key)) throw new ApiError(503); }
function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}
function verifyBytes(bytes: Buffer, size: number, expectedChecksum: string): Buffer {
  if (bytes.length !== size || checksum(bytes) !== expectedChecksum) throw new ApiError(503);
  return bytes;
}
class LocalStore {
  constructor(private readonly root: string) {}
  private async path(key: string, create: boolean): Promise<string> {
    validKey(key);
    const configured = resolve(this.root);
    if (create) await mkdir(configured, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(configured);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o022)) throw new ApiError(503);
    const root = await realpath(configured);
    const path = resolve(root, key), parent = dirname(path);
    if (!contained(root, path)) throw new ApiError(503);
    if (create) await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || await realpath(parent) !== parent) throw new ApiError(503);
    return path;
  }
  private async guardedOpen(path: string, flags: number): Promise<FileHandle> {
    const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await parent.stat(), current = await lstat(dirname(path));
      if (stat.ino !== current.ino || stat.dev !== current.dev || current.isSymbolicLink()) throw new ApiError(503);
      const file = await open(path, flags | constants.O_NOFOLLOW, 0o600);
      try {
        const after = await lstat(dirname(path));
        if (stat.ino !== after.ino || stat.dev !== after.dev || after.isSymbolicLink() || await realpath(dirname(path)) !== dirname(path)) throw new ApiError(503);
        return file;
      } catch (error) { await file.close(); throw error; }
    } finally { await parent.close(); }
  }
  async put(key: string, bytes: Buffer, _mime?: AssetMime, _attemptMarker?: string): Promise<void> {
    const path = await this.path(key, true);
    const file = await this.guardedOpen(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError(503, 'UPLOAD_STORAGE_CONFLICT');
      throw error;
    });
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      // 部分写入也保留给持久 intent；没有完整 checksum 证明时不可猜测 unlink。
      await file.close();
    }
  }
  async read(key: string, size: number, expectedChecksum: string): Promise<Buffer> {
    const path = await this.path(key, false);
    const file = await this.guardedOpen(path, constants.O_RDONLY);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== size || stat.size > MAX_UPLOAD_BYTES || stat.nlink !== 1) throw new ApiError(503);
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await file.read(bytes, offset, size - offset, offset);
        if (!result.bytesRead) throw new ApiError(503);
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await file.read(extra, 0, 1, offset)).bytesRead) throw new ApiError(503);
      return verifyBytes(bytes, size, expectedChecksum);
    } finally { await file.close(); }
  }
  async removeConditional(key: string, expectedChecksum: string): Promise<ConditionalRemoval> {
    try {
      const path = await this.path(key, false), file = await this.guardedOpen(path, constants.O_RDONLY);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_UPLOAD_BYTES) return 'mismatch';
        const bytes = await this.read(key, before.size, expectedChecksum).catch(error => {
          if (error instanceof ApiError) return null;
          throw error;
        });
        if (!bytes) return 'mismatch';
        const after = await file.stat(), current = await lstat(path);
        if (before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink() || current.nlink !== 1 ||
          before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          before.size !== current.size || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs ||
          await realpath(dirname(path)) !== dirname(path)) return 'mismatch';
        await unlink(path);
        return 'removed';
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }
  async remove(key: string): Promise<void> {
    try {
      const path = await this.path(key, false);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ApiError(503);
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
class S3Store {
  private readonly client: S3Client;
  constructor(private readonly settings: NonNullable<Config['s3']>) {
    // 不指定 credentials：使用 AWS SDK 默认凭据链。单次请求有连接及总时限，不盲目重试 PUT。
    this.client = new S3Client({ region: settings.region, endpoint: settings.endpoint, forcePathStyle: settings.forcePathStyle,
      maxAttempts: 1, requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 } });
  }
  async put(key: string, bytes: Buffer, mime: AssetMime, attemptMarker?: string): Promise<void> {
    const attempt = attemptMarker ?? randomBytes(24).toString('hex'), hash = checksum(bytes);
    // PUT 失联不即时 HEAD/删除：404 不能证明后端永远不会完成，持久 intent 到期后再复查。
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: key, Body: bytes,
        ContentType: mime, ContentLength: bytes.length, IfNoneMatch: '*',
        Metadata: { 'upload-attempt': attempt, 'upload-checksum': hash }, ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64') }),
      { abortSignal: AbortSignal.timeout(15000) });
    } catch (error) {
      const failure = error as { $metadata?: { httpStatusCode?: number }; name?: string };
      if ([409, 412].includes(failure.$metadata?.httpStatusCode ?? 0) || failure.name === 'PreconditionFailed') throw new ApiError(503, 'UPLOAD_STORAGE_CONFLICT');
      throw error;
    }
  }
  async read(key: string, size: number, expectedChecksum: string): Promise<Buffer> {
    const controller = new AbortController();
    let body: { destroy?: () => void } | undefined;
    const timer = setTimeout(() => { controller.abort(); body?.destroy?.(); }, 15000);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }), { abortSignal: controller.signal });
      body = response.Body as { destroy?: () => void } | undefined;
      if (!response.Body || response.ContentLength !== size) throw new ApiError(503);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        if (controller.signal.aborted) throw new ApiError(503);
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > size || total > MAX_UPLOAD_BYTES) throw new ApiError(503);
        chunks.push(bytes);
      }
      return verifyBytes(Buffer.concat(chunks, total), size, expectedChecksum);
    } finally {
      clearTimeout(timer);
      body?.destroy?.();
    }
  }
  async removeConditional(key: string, expectedChecksum: string, attemptMarker: string): Promise<ConditionalRemoval> {
    try {
      const object = await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key, ChecksumMode: 'ENABLED' }),
        { abortSignal: AbortSignal.timeout(15000) });
      if (object.Metadata?.['upload-attempt'] !== attemptMarker || object.Metadata?.['upload-checksum'] !== expectedChecksum ||
        object.ChecksumSHA256 !== Buffer.from(expectedChecksum, 'hex').toString('base64') || !object.ETag ||
        (object.ChecksumType !== undefined && object.ChecksumType !== 'FULL_OBJECT')) return 'mismatch';
      await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key, VersionId: object.VersionId, IfMatch: object.ETag }),
        { abortSignal: AbortSignal.timeout(15000) });
      return 'removed';
    } catch (error) {
      const failure = error as { $metadata?: { httpStatusCode?: number }; name?: string };
      if (failure.$metadata?.httpStatusCode === 404 || failure.name === 'NotFound' || failure.name === 'NoSuchKey') return 'missing';
      if (failure.$metadata?.httpStatusCode === 412 || failure.name === 'PreconditionFailed') return 'mismatch';
      throw error;
    }
  }
  async remove(key: string): Promise<void> {
    try {
      const object = await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
      // 启用版本控制时也删除此精确对象版本，而不是仅写删除标记、保留实际字节。
      await this.client.send(new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key, VersionId: object.VersionId, IfMatch: object.ETag }),
        { abortSignal: AbortSignal.timeout(15000) });
    } catch (error) {
      const failure = error as { $metadata?: { httpStatusCode?: number }; name?: string };
      if (failure.$metadata?.httpStatusCode !== 404 && failure.name !== 'NotFound' && failure.name !== 'NoSuchKey') throw error;
    }
  }
  close(): void { this.client.destroy(); }
}
export function createAssetStore(config: Config): AssetStore {
  if (config.nodeEnv === 'production' && config.storageMode !== 's3') throw new Error('生产素材存储必须使用 S3');
  if (!['local', 's3'].includes(config.storageMode)) throw new Error('素材存储模式未配置');
  const mode = config.storageMode;
  const local = config.storageLocalRoot ? new LocalStore(config.storageLocalRoot) : undefined;
  const s3 = config.s3 ? new S3Store({ ...config.s3 }) : undefined;
  if ((config.storageMode === 'local' && !local) || (config.storageMode === 's3' && !s3)) throw new Error('素材存储配置不完整');
  const run = async <T>(backend: StorageBackend, key: string, action: (store: LocalStore | S3Store) => Promise<T>): Promise<T> => {
    validKey(key);
    const store = backend === 'local' ? local : backend === 's3' ? s3 : undefined;
    if (!store) throw new ApiError(503);
    try { return await action(store); } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503);
    }
  };
  return {
    mode,
    put: (key, bytes, mime, attemptMarker) => {
      if (attemptMarker !== undefined && !/^[a-f0-9]{48}$/.test(attemptMarker)) return Promise.reject(new ApiError(503));
      return run(mode, key, store => store.put(key, bytes, mime, attemptMarker));
    },
    read: (backend, key, size, expectedChecksum) => {
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES || !/^[a-f0-9]{64}$/.test(expectedChecksum)) return Promise.reject(new ApiError(503));
      return run(backend, key, store => store.read(key, size, expectedChecksum));
    },
    remove: (backend, key) => run(backend, key, store => store.remove(key)),
    removeConditional: (backend, key, expectedChecksum, attemptMarker) => {
      if (!/^[a-f0-9]{64}$/.test(expectedChecksum) || !/^[a-f0-9]{48}$/.test(attemptMarker)) return Promise.reject(new ApiError(503));
      return run(backend, key, store => store.removeConditional(key, expectedChecksum, attemptMarker));
    },
    close: () => s3?.close(),
  };
}
