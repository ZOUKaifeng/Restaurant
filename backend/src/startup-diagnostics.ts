export type StartupStage = 'CONFIG' | 'DATABASE_CONFIG' | 'APP_SETUP' | 'DATABASE_READY' | 'LISTEN';

// Only exact, locally authored messages and known error codes may reach startup logs.
// Never serialize an exception, its URL input, SQL detail, stack, certificate or credentials.
const configKeys = [
  'NODE_ENV', 'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'APP_ORIGIN', 'HOST', 'PORT',
  'TOKEN_PEPPER', 'CURSOR_SECRET', 'OUTBOX_ENCRYPTION_KEY', 'EMAIL_MODE',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
  'STORAGE_MODE', 'S3_REGION', 'S3_BUCKET', 'S3_ENDPOINT', 'S3_FORCE_PATH_STYLE',
  'SITE_PORT', 'SITE_PUBLIC_ORIGIN',
] as const;
const messages = [
  ...configKeys.flatMap(key => [`缺少配置 ${key}`, `无效配置 ${key}`]),
  '无效 PostgreSQL URL',
  '数据库连接协议无效',
  'APP_ORIGIN 必须为精确 origin',
  '生产 APP_ORIGIN 必须 HTTPS',
  'TOKEN_PEPPER/CURSOR_SECRET 至少32字节',
  'OUTBOX_ENCRYPTION_KEY 必须64位hex',
  '生产素材必须配置 S3，不能回退本地存储',
  '无效 S3 配置',
  '无效 S3 endpoint',
  '本轮仅允许已核验的 DeepSeek 官方接口，禁止向未知主机发送密钥',
  '本轮指定 DeepSeek V4.1 Flash，model 必须 deepseek-flash',
  'SITE_PUBLIC_ORIGIN 必须为独立站点 origin',
  '本轮本地站点只允许独立端口的回环 HTTP 地址',
  '正式站点必须配置 HTTPS origin，公网发布尚未验收',
  '本地数据库 URL 不得附带主机、角色或会话覆盖参数',
  '远程数据库必须配置 sslmode=verify-full 和 DATABASE_SSL_CA（或 DATABASE_SSL_CA_FILE）',
  '远程数据库证书只能配置 DATABASE_SSL_CA 或 DATABASE_SSL_CA_FILE 其中一个',
  '远程数据库证书只允许通过 DATABASE_SSL_CA 或 DATABASE_SSL_CA_FILE 配置，禁止混用 URL SSL 参数',
  '远程数据库 URL 不得附带主机、角色或其他会话覆盖参数',
  '数据库 CA 文件无效',
  '应用数据库角色具有不允许的管理权限',
  '需要 PostgreSQL 16 或 17',
] as const;
const safeMessages = new Map<string, string>(messages.map(message => [message, message]));
const connectionCodes: Readonly<Record<string, string>> = {
  '28P01': '数据库身份验证失败；检查 DATABASE_URL 应用账号密码',
  '28000': '数据库连接授权被拒绝；检查连接来源和账号设置',
  '42501': '应用数据库账号缺少必要权限；不要改用管理员账号绕过',
  '42P01': '缺少必要数据库表；核对目标数据库和受控迁移记录',
  '42703': '必要数据库列不匹配；核对版本与迁移记录',
  '3D000': '目标数据库不存在；检查 DATABASE_URL 的数据库名',
  ENOTFOUND: '无法解析数据库主机；检查 DATABASE_URL 和网络',
  EAI_AGAIN: '数据库主机解析暂时失败',
  ECONNREFUSED: '数据库连接被拒绝；检查端口和服务状态',
  ETIMEDOUT: '数据库连接超时；检查网络和连接来源限制',
  CERT_HAS_EXPIRED: '数据库证书已过期',
  ERR_TLS_CERT_ALTNAME_INVALID: '数据库证书与主机不匹配；保持完整TLS验证',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '数据库证书链验证失败；核对 DATABASE_SSL_CA',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '数据库签发者证书不可验证；核对 DATABASE_SSL_CA',
  SELF_SIGNED_CERT_IN_CHAIN: '数据库证书信任链无效；核对 DATABASE_SSL_CA',
  DEPTH_ZERO_SELF_SIGNED_CERT: '数据库自签名证书不可验证；核对 DATABASE_SSL_CA',
};
const certificateCodes: Readonly<Record<string, string>> = {
  ENOENT: 'DATABASE_SSL_CA_FILE 文件不存在；Railway请使用 DATABASE_SSL_CA 的证书文本',
  EACCES: 'DATABASE_SSL_CA_FILE 不可读取',
  ERR_INVALID_URL: 'DATABASE_URL 格式无效',
};
const stages: Readonly<Record<StartupStage, string>> = {
  CONFIG: '环境配置', DATABASE_CONFIG: '数据库连接配置', APP_SETUP: '应用初始化',
  DATABASE_READY: '数据库连通或结构权限检查', LISTEN: '监听端口',
};

export function startupFailureLine(stage: StartupStage, error: unknown): string {
  let message = '详细异常已隐藏；请核对本阶段配置，不要将密钥写入日志';
  // Even a malicious getter must not make the failure handler throw or reveal input.
  try {
    if (error && typeof error === 'object') {
      const candidate = error as { message?: unknown; code?: unknown };
      const rawMessage = candidate.message, code = candidate.code;
      if (typeof rawMessage === 'string' && safeMessages.has(rawMessage)) {
        message = safeMessages.get(rawMessage)!;
      } else if (typeof code === 'string') {
        if (stage === 'DATABASE_CONFIG' && Object.hasOwn(certificateCodes, code)) {
          message = certificateCodes[code]!;
        } else if (stage === 'DATABASE_READY' && Object.hasOwn(connectionCodes, code)) {
          message = connectionCodes[code]!;
        } else if (stage === 'LISTEN' && code === 'EADDRINUSE') {
          message = '监听端口已被占用；检查 HOST / PORT';
        } else if (stage === 'LISTEN' && code === 'EADDRNOTAVAIL') {
          message = '监听地址不可用；检查 HOST';
        }
      }
    }
  } catch { /* Unknown exceptions remain fully hidden. */ }
  return `后端启动失败 [${stage}] ${stages[stage]}：${message}；拒绝启动\n`;
}
