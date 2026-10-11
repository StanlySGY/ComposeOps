/**
 * 跨路由复用的 Fastify JSON Schema 片段。
 *
 * 放在这里的都是"字段集必须与某个服务端定义严格对应"的 schema:
 * Fastify 默认 removeAdditional: true,`additionalProperties: false` 会静默剥掉
 * 未声明字段而不报错 —— 一处漏键就等于该配置永久保存不上,且无任何错误可查。
 * 两个路由各抄一份必然漂移,所以只留一份。
 */

/**
 * 必须与 services/notifications.js 的 DEFAULTS 键集一一对应:
 * saveNotificationConfig 遍历 Object.keys(DEFAULTS) 取值,少声明一个键该项就存不进去。
 * 渠道枚举与数量上限必须与 CHANNEL_TYPES(7 种)对齐:getNotificationConfig 恒返回
 * 7 个渠道,前端回存时会原样带回全部渠道,上限不足会直接 400 导致保存失败。
 * 数值区间沿用服务端 clamp(memoryThreshold 1..100、intervalSeconds 30..3600 等),
 * schema 只挡非数值类型,不额外收紧,否则越界值的行为会从"钳到边界"变成"400"。
 * token/smtpPassword 只设长度上限:getNotificationConfig(true) 会把它们掩成
 * 'configured',保存时再跳过该值,掩码需要能原样回传。
 */
const NOTIFICATION_CHANNEL_TYPES = ['bark', 'telegram', 'wecom', 'dingtalk', 'feishu', 'email', 'webhook'];
export const notificationConfigBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    type: { type: 'string', enum: NOTIFICATION_CHANNEL_TYPES },
    endpoint: { type: 'string', maxLength: 2048 },
    token: { type: 'string', maxLength: 512 },
    chatId: { type: 'string', maxLength: 128 },
    memoryThreshold: { type: 'number' },
    dockerStorageThresholdGb: { type: 'number' },
    intervalSeconds: { type: 'number' },
    smtpHost: { type: 'string', maxLength: 255 },
    smtpPort: { type: 'number' },
    smtpSecure: { type: 'boolean' },
    smtpUser: { type: 'string', maxLength: 255 },
    smtpPassword: { type: 'string', maxLength: 512 },
    emailFrom: { type: 'string', maxLength: 255 },
    emailTo: { type: 'string', maxLength: 1024 },
    events: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 32 } },
    channels: {
      type: 'array',
      maxItems: NOTIFICATION_CHANNEL_TYPES.length,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: NOTIFICATION_CHANNEL_TYPES },
          enabled: { type: 'boolean' },
          endpoint: { type: 'string', maxLength: 2048 },
          token: { type: 'string', maxLength: 512 },
          chatId: { type: 'string', maxLength: 128 },
          smtpHost: { type: 'string', maxLength: 255 },
          smtpPort: { type: 'number' },
          smtpSecure: { type: 'boolean' },
          smtpUser: { type: 'string', maxLength: 255 },
          smtpPassword: { type: 'string', maxLength: 512 },
          emailFrom: { type: 'string', maxLength: 255 },
          emailTo: { type: 'string', maxLength: 1024 },
        },
      },
    },
  },
};

/**
 * 以下为 AI 编排路由(ai.js / agent.js)共享的基础 schema。
 * idField/numericId/limitField:仅挡畸形类型,越界/语义由各处理函数与 db clamp 兜住
 * (见 ai.js 文件头说明)。
 */
export const idField = { type: 'string', maxLength: 128 };
export const numericId = { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 32 }] };
export const limitField = (maximum) => ({ type: 'integer', minimum: 1, maximum });

