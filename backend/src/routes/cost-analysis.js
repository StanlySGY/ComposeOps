/**
 * 成本分析 API 路由
 */
import {
  getContainerResourceStats,
  getImageSizeStats,
  getStorageStats,
  getProjectCostSummary,
  getCostTrends,
  recordCostSnapshot,
  getCostAnalysisReport,
  getOptimizationSuggestions
} from '../services/cost-analysis.js';
import { addOperation } from '../lib/db.js';

const costStorageSectionSchema = {
  type: 'object',
  properties: {
    active: { type: 'number' },
    total: { type: 'number' },
    sizeMB: { type: 'number' },
    reclaimableMB: { type: 'number' },
  },
};
const costStorageSchema = {
  type: 'object',
  properties: {
    images: costStorageSectionSchema,
    containers: costStorageSectionSchema,
    volumes: costStorageSectionSchema,
    buildCache: costStorageSectionSchema,
  },
};

export default async function costAnalysisRoutes(api, _opts) {
  // 获取完整成本分析报告
  api.get('/report', {
    schema: {
      summary: '获取完整成本分析报告',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'object',
          properties: {
            summary: {
              type: 'object',
              properties: {
                totalProjects: { type: 'number' },
                totalContainers: { type: 'number' },
                runningContainers: { type: 'number' },
                totalCPUPercent: { type: 'number' },
                totalMemoryMB: { type: 'number' },
                totalImagesMB: { type: 'number' },
                storageTotalMB: { type: 'number' },
                reclaimableMB: { type: 'number' }
              }
            },
            containers: { type: 'array' },
            images: { type: 'array' },
            storage: costStorageSchema,
            projects: { type: 'array' },
            trends: { type: 'array' }
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const report = await getCostAnalysisReport();
    return report;
  });

  // 获取容器资源统计
  api.get('/containers', {
    schema: {
      summary: '获取容器资源使用统计',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              containerId: { type: 'string' },
              containerName: { type: 'string' },
              projectName: { type: 'string' },
              state: { type: 'string' },
              cpuPercent: { type: 'number' },
              memoryUsageMB: { type: 'number' },
              memoryLimitMB: { type: 'number' },
              created: { type: 'number' }
            }
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const stats = await getContainerResourceStats();
    return stats;
  });

  // 获取镜像大小统计
  api.get('/images', {
    schema: {
      summary: '获取镜像大小统计',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              sizeMB: { type: 'number' },
              created: { type: 'number' }
            }
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const stats = await getImageSizeStats();
    return stats;
  });

  // 获取存储使用统计
  api.get('/storage', {
    schema: {
      summary: '获取存储使用统计',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'object',
          properties: {
            images: costStorageSectionSchema,
            containers: costStorageSectionSchema,
            volumes: costStorageSectionSchema,
            buildCache: costStorageSectionSchema
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const stats = await getStorageStats();
    return stats;
  });

  // 获取项目成本汇总
  api.get('/projects', {
    schema: {
      summary: '获取项目成本汇总',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              projectName: { type: 'string' },
              containerCount: { type: 'number' },
              runningCount: { type: 'number' },
              totalCPUPercent: { type: 'number' },
              totalMemoryMB: { type: 'number' }
            }
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const summary = await getProjectCostSummary();
    return summary;
  });

  // 获取成本趋势
  api.get('/trends', {
    schema: {
      summary: '获取成本趋势数据',
      tags: ['cost-analysis'],
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'number', minimum: 1, maximum: 30, default: 7 }
        }
      },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              timestamp: { type: 'number' },
              totalContainers: { type: 'number' },
              runningContainers: { type: 'number' },
              totalCPUPercent: { type: 'number' },
              totalMemoryMB: { type: 'number' },
              totalImagesMB: { type: 'number' },
              storageTotalMB: { type: 'number' }
            }
          }
        }
      }
    }
  }, async (request, _reply) => {
    const { days = 7 } = request.query;
    const trends = getCostTrends(days);
    return trends;
  });

  // 记录成本快照
  api.post('/snapshot', {
    schema: {
      summary: '记录当前成本快照',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'object',
          properties: {
            timestamp: { type: 'number' },
            totalContainers: { type: 'number' },
            runningContainers: { type: 'number' },
            totalCPUPercent: { type: 'number' },
            totalMemoryMB: { type: 'number' },
            totalImagesMB: { type: 'number' },
            storageTotalMB: { type: 'number' }
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const snapshot = await recordCostSnapshot();
    
    await addOperation({
      type: 'cost',
      action: 'snapshot',
      target: 'system',
      status: 'success',
      timestamp: Date.now()
    });
    
    return snapshot;
  });

  // 获取优化建议
  api.get('/suggestions', {
    schema: {
      summary: '获取成本优化建议',
      tags: ['cost-analysis'],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
              title: { type: 'string' },
              description: { type: 'string' },
              action: { type: 'string' }
            }
          }
        }
      }
    }
  }, async (_request, _reply) => {
    const suggestions = await getOptimizationSuggestions();
    return suggestions;
  });
}
