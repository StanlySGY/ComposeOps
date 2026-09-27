/**
 * 模板市场路由
 * 提供社区模板、自定义模板、收藏管理
 */
import {
  discoverTemplateWithAI,
  getAllTemplates,
  searchTemplates,
  getMarketplaceStats,
  createCustomTemplate,
  updateCustomTemplate,
  deleteCustomTemplate,
  addFavorite,
  removeFavorite
} from '../services/marketplace.js';
import { addOperation } from '../lib/db.js';

export default async function marketplaceRoutes(fastify) {
  // 获取所有模板
  fastify.get('/templates', {
    schema: {
      description: '获取所有模板（内置+社区+自定义）',
      response: {
        200: {
          type: 'object',
          properties: {
            builtin: { type: 'array' },
            community: { type: 'array' },
            custom: { type: 'array' },
            communityStatus: {
              type: 'object',
              properties: {
                available: { type: 'boolean' },
                configured: { type: 'boolean' },
                message: { type: 'string' },
              },
            },
          }
        }
      }
    }
  }, async () => {
    const templates = await getAllTemplates();
    return templates;
  });

  // 搜索模板
  fastify.get('/templates/search', {
    schema: {
      description: '搜索模板',
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          category: { type: 'string' },
          source: { type: 'string', enum: ['all', 'builtin', 'community', 'custom'] },
          onlyFavorites: { type: 'string', enum: ['true', 'false'] }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            results: { type: 'array' }
          }
        }
      }
    }
  }, async (req) => {
    const { q, category, source, onlyFavorites } = req.query;
    const results = await searchTemplates(q, {
      category,
      source,
      onlyFavorites: onlyFavorites === 'true'
    });
    return { results };
  });

  // 获取统计信息
  fastify.get('/stats', {
    schema: {
      description: '获取模板市场统计',
      response: {
        200: {
          type: 'object',
          properties: {
            totalBuiltin: { type: 'number' },
            totalCommunity: { type: 'number' },
            totalCustom: { type: 'number' },
            totalFavorites: { type: 'number' },
            communityAvailable: { type: 'boolean' },
            communityMessage: { type: 'string' },
            categories: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  }, async () => {
    const stats = await getMarketplaceStats();
    return stats;
  });

  // 创建自定义模板
  // AI 发现:按应用名生成可一键部署的模板草稿(仅返回草稿,入库走 custom 创建)
  fastify.post('/templates/ai-discover', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string', minLength: 1, maxLength: 120 } },
      },
    },
  }, async (req, reply) => {
    try {
      const template = await discoverTemplateWithAI(req.body?.query);
      return { template };
    } catch (error) {
      return reply.code(error.statusCode || 502).send({ error: 'ai_discover_failed', message: error.message });
    }
  });

  fastify.post('/templates/custom', {
    schema: {
      description: '创建自定义模板',
      body: {
        type: 'object',
        required: ['name', 'defaultCompose'],
        properties: {
          name: { type: 'string', maxLength: 200 },
          category: { type: 'string', maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
          defaultCompose: { type: 'string' },
          envSchema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                default: { type: 'string' },
                type: { type: 'string' },
                secret: { type: 'boolean' }
              }
            }
          }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            template: { type: 'object' }
          }
        }
      }
    }
  }, async (req, reply) => {
    try {
      const template = await createCustomTemplate(req.body);
      addOperation({ action: 'marketplace.template.create', status: 'success', detail: template.name });
      return { template };
    } catch (error) {
      return reply.code(error.statusCode || 422).send({ error: 'template_invalid', message: error.message, issues: error.issues || [] });
    }
  });

  // 更新自定义模板
  fastify.patch('/templates/custom/:id', {
    schema: {
      description: '更新自定义模板',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 200 },
          category: { type: 'string', maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
          defaultCompose: { type: 'string' },
          envSchema: { type: 'array' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            template: { type: 'object' }
          }
        }
      }
    }
  }, async (req, reply) => {
    try {
      const template = await updateCustomTemplate(req.params.id, req.body);
      addOperation({ action: 'marketplace.template.update', status: 'success', detail: template.name });
      return { template };
    } catch (error) {
      return reply.code(error.statusCode || 422).send({ error: 'template_invalid', message: error.message, issues: error.issues || [] });
    }
  });

  // 删除自定义模板
  fastify.delete('/templates/custom/:id', {
    schema: {
      description: '删除自定义模板',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            message: { type: 'string' }
          }
        }
      }
    }
  }, async (req, reply) => {
    try {
      await deleteCustomTemplate(req.params.id);
      addOperation({ action: 'marketplace.template.delete', status: 'success', detail: req.params.id });
      return { message: '模板已删除' };
    } catch (error) {
      return reply.code(error.statusCode || 422).send({ error: 'template_delete_failed', message: error.message });
    }
  });

  // 添加收藏
  fastify.post('/favorites/:templateId', {
    schema: {
      description: '添加模板收藏',
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            favorites: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  }, async (req) => {
    const favorites = addFavorite(req.params.templateId);
    return { favorites };
  });

  // 移除收藏
  fastify.delete('/favorites/:templateId', {
    schema: {
      description: '移除模板收藏',
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'string' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            favorites: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  }, async (req) => {
    const favorites = removeFavorite(req.params.templateId);
    return { favorites };
  });
}
