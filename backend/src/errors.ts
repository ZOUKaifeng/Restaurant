const errors: Record<number, [string, string]> = {
  400: ['REQUEST_INVALID', '请求格式不合法'],
  401: ['UNAUTHENTICATED', '认证失效或登录凭据不正确'],
  403: ['FORBIDDEN', '禁止操作、邮箱尚未验证或账号不可用'],
  404: ['NOT_FOUND', '对象不存在或不属于当前商家'],
  409: ['CONFLICT', '同一幂等键内容冲突或当前业务状态不允许'],
  410: ['ACTION_TOKEN_EXPIRED', '动作令牌过期或失效'],
  412: ['REVISION_CONFLICT', 'If-Match与当前版本不匹配'],
  415: ['UNSUPPORTED_MEDIA_TYPE', '仅接受application/json'],
  422: ['VALIDATION_FAILED', '字段或语义校验失败'],
  428: ['PRECONDITION_REQUIRED', '缺少If-Match'],
  429: ['RATE_LIMITED', '触发速率限制'],
  503: ['SERVICE_UNAVAILABLE', '必要服务不可用，不返回假成功'],
};
export class ApiError extends Error {
  constructor(public status: number, public code = errors[status]![0], public details: { field: string; code: string }[] = []) { super(errors[status]![1]); }
}
export function errorBody(status: number, requestId: string) {
  const [code, message] = errors[status]!;
  return { code, message, request_id: requestId, details: [] };
}
export function invalid(field: string, code = 'INVALID'): never { throw new ApiError(422, undefined, [{ field, code }]); }
