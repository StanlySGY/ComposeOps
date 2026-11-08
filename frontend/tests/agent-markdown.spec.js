import { describe, expect, it } from 'vitest';
import { renderAgentMarkdown } from '../src/lib/agent-markdown.js';

/**
 * 这些用例针对"模型输出的富内容在暗色主题里渲染很差"这一类问题。
 * 关键点:renderAgentMarkdown 是净化后再做 DOM 后处理的纯函数,
 * 所有断言都只看最终 HTML 字符串。
 */
describe('renderAgentMarkdown — 安全底线', () => {
  it('剥掉 script 与事件属性', () => {
    const html = renderAgentMarkdown('<div onclick="alert(1)">hi</div><script>alert(2)</script>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('<script');
    expect(html).toContain('hi');
  });

  it('剥掉 javascript: 协议链接', () => {
    const html = renderAgentMarkdown('<a href="javascript:alert(1)">x</a>');
    expect(html).not.toContain('javascript:');
  });

  it('svg 内的事件属性同样被剥掉', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 10 10"><rect width="10" height="10" onload="alert(1)" /></svg>');
    expect(html).not.toContain('onload');
    expect(html).toContain('<svg');
  });

  it('空白输入返回空串', () => {
    expect(renderAgentMarkdown('')).toBe('');
    expect(renderAgentMarkdown(null)).toBe('');
  });
});

describe('renderAgentMarkdown — 内联 style 颜色治理', () => {
  it('剥掉颜色声明但保留布局声明', () => {
    const html = renderAgentMarkdown('<table style="width:100%;background:#ffffff;color:#000;text-align:center"><tr><td>x</td></tr></table>');
    // 颜色类声明必须消失(暗色主题里白底黑字是主要观感缺陷)
    expect(html).not.toMatch(/background\s*:/i);
    expect(html).not.toMatch(/color\s*:\s*#000/i);
    // 布局意图保留
    expect(html).toContain('width:100%');
    expect(html).toContain('text-align:center');
  });

  it('background 简写整条丢弃(可能夹带渐变/图片色)', () => {
    const html = renderAgentMarkdown('<div style="background:linear-gradient(90deg,#fff,#eee);padding:8px">x</div>');
    expect(html).not.toMatch(/background\s*:/i);
    expect(html).toContain('padding:8px');
  });

  it('font-family 被移除,交给主题字体', () => {
    const html = renderAgentMarkdown('<p style="font-family:Comic Sans MS;margin:4px 0">x</p>');
    expect(html).not.toMatch(/font-family/i);
    expect(html).toContain('margin:4px 0');
  });
});

describe('renderAgentMarkdown — SVG 主题化与尺寸', () => {
  it('白色填充被重映射到暗色面板色', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="white" /></svg>');
    expect(html).not.toMatch(/fill="white"/i);
    expect(html).toMatch(/fill="#1f2530"/i);
  });

  it('lightgray 底色也被重映射', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="lightgray" /></svg>');
    expect(html).not.toMatch(/lightgray/i);
    expect(html).toMatch(/fill="#1f2530"/i);
  });

  it('黑色形状重映射为面板色 + 描边(暗底上不可见的老问题)', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#000000" /></svg>');
    expect(html).toMatch(/fill="#262c37"/i);
    expect(html).toMatch(/stroke="#4b5563"/i);
  });

  it('文字颜色一律交给 CSS(模型常写 fill=black)', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 10 10"><text x="1" y="9" fill="black">标签</text></svg>');
    const text = html.match(/<text[^>]*>/i)?.[0] || '';
    expect(text).not.toMatch(/fill=/i);
    expect(text).not.toMatch(/stroke=/i);
  });

  it('缺 width/height 但有 viewBox 时标记为流体并补 preserveAspectRatio', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 120 60"><rect width="120" height="60" /></svg>');
    expect(html).toContain('data-fluid="1"');
    expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    // 只有 <svg> 自己的 width/height 要移除;内部 <rect> 的尺寸是图形数据,必须保留
    const openTag = html.match(/<svg[^>]*>/i)?.[0] || '';
    expect(openTag).not.toMatch(/\swidth="/i);
    expect(openTag).not.toMatch(/\sheight="/i);
    expect(html).toContain('<rect width="120" height="60">');
  });

  it('带 width/height 但缺 viewBox 时用它们合成 viewBox,再交给流体布局', () => {
    const html = renderAgentMarkdown('<svg width="640" height="320"><rect width="640" height="320" /></svg>');
    expect(html).toContain('viewBox="0 0 640 320"');
    expect(html).toContain('data-fluid="1"');
    // 硬编码尺寸必须移除,否则窄屏会溢出
    const openTag = html.match(/<svg[^>]*>/i)?.[0] || '';
    expect(openTag).not.toMatch(/\swidth="/i);
    expect(openTag).not.toMatch(/\sheight="/i);
  });

  it('SVG 被包进可放大的 rich-block', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>');
    expect(html).toContain('class="rich-block"');
    expect(html).toContain('rich-zoom-btn');
  });

  it('满画布背景底板不加描边(否则整张图会多出一圈外框)', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 720 144"><rect x="0" y="0" width="720" height="144" fill="#0f1720" /><rect x="20" y="20" width="80" height="40" fill="#000000" /></svg>');
    const background = html.match(/<rect[^>]*width="720"[^>]*>/i)?.[0] || '';
    expect(background).not.toMatch(/stroke=/i);
    // 内部的小形状仍需要描边来保证轮廓可辨
    const inner = html.match(/<rect[^>]*width="80"[^>]*>/i)?.[0] || '';
    expect(inner).toMatch(/stroke=/i);
  });

  it('背景底板写在 style 里的亮色也被剥掉(不能因为跳过描边逻辑而漏掉颜色清理)', () => {
    const html = renderAgentMarkdown('<svg viewBox="0 0 40 20"><rect width="40" height="20" style="fill:#ffffff" /><text x="4" y="14">x</text></svg>');
    const background = html.match(/<rect[^>]*>/i)?.[0] || '';
    expect(background).not.toMatch(/fill:\s*#f{3,6}/i);
    expect(background).not.toMatch(/stroke=/i);
  });
});

describe('renderAgentMarkdown — HTML 表格主题化', () => {
  it('裸 HTML 表格被包进主题容器(agent-table-wrap)', () => {
    const html = renderAgentMarkdown('<table><thead><tr><th>服务</th></tr></thead><tbody><tr><td>nginx</td></tr></tbody></table>');
    expect(html).toContain('agent-table-wrap');
    // <table> 标签本身不加 class,避免影响既有断言与第三方片段
    expect(html).toContain('<table>');
  });

  it('剥掉 HTML4 的 bgcolor / border 属性', () => {
    const html = renderAgentMarkdown('<table border="1" bgcolor="#ffffff"><tr><td>x</td></tr></table>');
    expect(html).not.toMatch(/bgcolor/i);
    expect(html).not.toMatch(/border="1"/i);
  });

  it('markdown 表格依然正常渲染', () => {
    const html = renderAgentMarkdown('| 服务 | 状态 |\n| --- | --- |\n| nginx | 运行 |');
    expect(html).toContain('<table');
    expect(html).toContain('nginx');
    expect(html).toContain('agent-table-wrap');
  });
});

describe('renderAgentMarkdown — 代码块', () => {
  it('带语言标注的代码块挂上 data-lang', () => {
    const html = renderAgentMarkdown('```yaml\nservices:\n  web:\n    image: nginx\n```');
    expect(html).toContain('data-lang="yaml"');
  });

  it('无语言代码块标记为 text 以便隐藏徽标', () => {
    const html = renderAgentMarkdown('```\nplain\n```');
    expect(html).toContain('data-lang="text"');
  });

  it('json/jsonc 等以 js 开头的语言标识不被误判(否则正文会多出 "on" 前缀)', () => {
    const html = renderAgentMarkdown('```json\n{"a":1}\n```');
    expect(html).toContain('language-json');
    expect(html).not.toContain('language-js"');
    expect(html).not.toMatch(/>on\s/);
    expect(html).toContain('{"a":1}');
  });

  it('html 代码块渲染为富内容并附带可折叠源码', () => {
    const html = renderAgentMarkdown('```html\n<table><tr><td>富内容</td></tr></table>\n```');
    expect(html).toContain('rich-block');
    expect(html).toContain('查看源码');
    expect(html).toContain('富内容');
  });

  it('内部 trace JSON 代码块被整块丢弃', () => {
    const html = renderAgentMarkdown('```json\n{"phase":"tool_requested","tool":"restart_service"}\n```');
    expect(html).not.toContain('tool_requested');
  });
});

describe('renderAgentMarkdown — 富内容不重复渲染', () => {
  const svg = '<svg viewBox="0 0 720 144"><rect width="720" height="144" fill="white" /><text x="20" y="40">架构图</text></svg>';

  it('模型自己附的"查看源码" details 里的围栏不再被二次渲染', () => {
    // 用户在截图里看到的就是这个:标题 + 一张图 + 又一个"查看源码" + 同一张图
    const html = renderAgentMarkdown(`${svg}\n\n<details><summary>查看源码</summary>\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n</details>`);
    expect((html.match(/class="rich-block"/g) || []).length).toBe(1);
    expect((html.match(/查看源码/g) || []).length).toBe(1);
    expect((html.match(/<details/g) || []).length).toBe(1);
  });

  it('details 内的源码保持为代码文本,而不是又渲染成一张图', () => {
    const html = renderAgentMarkdown(`<details><summary>查看源码</summary>\n\n\`\`\`html\n<table><tr><td>x</td></tr></table>\n\`\`\`\n\n</details>`);
    expect(html).not.toContain('rich-block');
    expect(html).toContain('language-html');
  });

  it('围栏富内容与源码折叠仍成对出现', () => {
    const html = renderAgentMarkdown(`\`\`\`svg\n${svg}\n\`\`\``);
    expect((html.match(/class="rich-block"/g) || []).length).toBe(1);
    expect((html.match(/查看源码/g) || []).length).toBe(1);
    // 渲染结果在折叠块之前,源码在其中
    expect(html.indexOf('rich-block')).toBeLessThan(html.indexOf('查看源码'));
  });

  it('表格不会被放大块重复包裹', () => {
    const html = renderAgentMarkdown('<table><tr><td>a</td></tr></table>');
    expect((html.match(/class="rich-block"/g) || []).length).toBe(1);
    expect((html.match(/agent-table-wrap/g) || []).length).toBe(1);
  });

  it('details 内的普通语言围栏仍渲染为代码块,不会漏出裸反引号', () => {
    const html = renderAgentMarkdown('<details><summary>原始输出</summary>\n\n```json\n{"a":1}\n```\n\n</details>');
    expect(html).toContain('<pre');
    expect(html).toContain('language-json');
    expect(html).not.toContain('```');
  });

  it('闭合标签带空白或大写时,后续围栏仍能被富内容化', () => {
    const svg = '<svg viewBox="0 0 20 20"><rect width="20" height="20" /></svg>';
    for (const closing of ['</details>', '</details >', '</DETAILS>']) {
      const html = renderAgentMarkdown(`<details><summary>源码</summary>\n\n\`\`\`svg\n${svg}\n\`\`\`\n\n${closing}\n\n\`\`\`svg\n${svg}\n\`\`\``);
      expect((html.match(/class="rich-block"/g) || []).length, `closing=${closing}`).toBe(1);
    }
  });
});

describe('renderAgentMarkdown — 不回归', () => {
  it('流式期间未闭合围栏也能渲染表格而不是裸源码', () => {
    const html = renderAgentMarkdown('```html\n<table><tr><td>半截</td></tr></table>');
    expect(html).toContain('<table');
    expect(html).not.toContain('```');
  });

  it('链接自动带安全属性', () => {
    const html = renderAgentMarkdown('[Docker 文档](https://docs.docker.com/)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('内部协议残片(tool_call / _icall)被剥离', () => {
    expect(renderAgentMarkdown('前文_icall {"name":"x","arguments":{}}>后文')).not.toContain('_icall');
    expect(renderAgentMarkdown('<tool_call>{"name":"project.list_managed"}')).not.toContain('tool_call');
    expect(renderAgentMarkdown('正常回答')).toContain('正常回答');
  });
});


describe('代码复制不改变原始正文', () => {
  const code = source => { const root = document.createElement('div'); root.innerHTML = renderAgentMarkdown(source); return root.querySelector('code'); };
  it('标准代码围栏不在正文前多加换行', () => { expect(code('```sh\necho 正文\n```').textContent).toBe('echo 正文\n'); });
  it('用户保留的首行空白仍保留', () => { expect(code('```yaml\n\nservices: {}\n```').textContent).toBe('\nservices: {}\n'); });
  it('jsonc语言标记不被拆成正文', () => { const value = code('```jsonc\n{}\n```'); expect(value.className).toBe('language-jsonc'); expect(value.textContent).toBe('{}\n'); });
  it('历史粘连yaml围栏仍能恢复代码', () => { expect(code('```yamlservices: {}\n```').textContent).toBe('services: {}\n'); });
});
