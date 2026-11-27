import { describe, it, expect } from 'vitest';
import { parseDotenv, serializeDotenv, validateDotenv, isSecretKey } from '../src/lib/dotenv.js';

describe('parseDotenv', () => {
  it('parses plain KEY=VALUE pairs', () => {
    const entries = parseDotenv('FOO=bar\nBAZ=qux\n');
    expect(entries).toEqual([
      { key: 'FOO', value: 'bar', comment: undefined, isSecret: false },
      { key: 'BAZ', value: 'qux', comment: undefined, isSecret: false },
    ]);
  });

  it('recognizes secret keys by keyword', () => {
    const entries = parseDotenv('API_KEY=abc\nDB_PASSWORD=secret\nPUBLIC=visible\n');
    expect(entries[0].isSecret).toBe(true);
    expect(entries[1].isSecret).toBe(true);
    expect(entries[2].isSecret).toBe(false);
    expect(isSecretKey('MY_SECRET_TOKEN')).toBe(true);
    expect(isSecretKey('NORMAL_VALUE')).toBe(false);
  });

  it('attaches standalone comments and trailing comments', () => {
    const entries = parseDotenv('# database config\nDB_HOST=localhost # primary\n\n# token\nTOKEN=xyz\n');
    expect(entries[0].comment).toBe('primary'); // 行内注释优先于行前注释
    expect(entries[0].value).toBe('localhost');
    expect(entries[1].comment).toBe('token');
  });

  it('supports quoted values with hashes and spaces', () => {
    const entries = parseDotenv('MESSAGE="hello # world"\nURL=\'https://example.com/a#b\'\n');
    expect(entries[0].value).toBe('hello # world');
    expect(entries[1].value).toBe('https://example.com/a#b');
  });

  it('supports export prefix', () => {
    const entries = parseDotenv('export MODE=prod\n');
    expect(entries[0].key).toBe('MODE');
    expect(entries[0].value).toBe('prod');
  });

  it('ignores blank lines and malformed lines', () => {
    const entries = parseDotenv('\n\nFOO=1\nnot-a-valid-line\n\nBAR=2\n');
    expect(entries.map((e) => e.key)).toEqual(['FOO', 'BAR']);
  });
});

describe('serializeDotenv', () => {
  it('round-trips parsed entries', () => {
    const raw = 'A=1\nB="two words"\n';
    const entries = parseDotenv(raw);
    const out = serializeDotenv(entries);
    expect(parseDotenv(out)).toEqual(entries);
  });

  it('quotes values containing spaces or special chars', () => {
    const out = serializeDotenv([{ key: 'MSG', value: 'hello world', comment: undefined, isSecret: false }]);
    expect(out).toBe('MSG="hello world"\n');
  });

  it('emits comment line before key', () => {
    const out = serializeDotenv([{ key: 'K', value: 'v', comment: '说明', isSecret: false }]);
    expect(out).toBe('# 说明\nK=v\n');
  });
});

describe('validateDotenv', () => {
  it('accepts valid env content', () => {
    expect(validateDotenv('A=1\n# comment\nB="two"\n').ok).toBe(true);
  });
  it('rejects malformed lines', () => {
    const result = validateDotenv('A=1\nthis is not env\n');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
  });
});

describe('dotenv 文档无损编辑', () => {
  it('编辑一行保留其它行的引号、插值、注释、空白与 CRLF', async () => {
    const { parseDotenvDocument, editDotenvDocument } = await import('../src/lib/dotenv.js');
    const raw = "# header\r\n\r\n  export TOKEN = 'literal$VALUE' # keep\r\nURL=${BASE:-https://host}\r\nMODE = before\r\n\r\n# tail\r\n";
    const doc = parseDotenvDocument(raw);
    const entries = doc.nodes.map(node => ({ ...node })); entries[2].value = 'after';
    expect(editDotenvDocument(doc, entries)).toBe(raw.replace('MODE = before', 'MODE = after'));
  });
  it('重复键按行身份编辑，重排与新增不粘连末尾无换行的行', async () => {
    const { parseDotenvDocument, editDotenvDocument } = await import('../src/lib/dotenv.js');
    const doc = parseDotenvDocument('A=first\nA=second');
    expect(editDotenvDocument(doc, [{ ...doc.nodes[0], value: 'changed' }, doc.nodes[1]])).toBe('A=changed\nA=second');
    expect(editDotenvDocument(doc, [doc.nodes[1], doc.nodes[0], { key: 'B', value: 'new' }])).toBe('A=second\nA=first\nB=new\n');
  });
  it('修改注释仅改原位置，单引号字面值修改后仍禁用替换', async () => {
    const { parseDotenvDocument, editDotenvDocument } = await import('../src/lib/dotenv.js');
    const raw = "# keep\n# old\nTOKEN='one$VAR'\nMODE=x # inline\n";
    const doc = parseDotenvDocument(raw);
    expect(editDotenvDocument(doc, [{ ...doc.nodes[0], value: 'two$VAR', comment: 'new' }, { ...doc.nodes[1], comment: 'updated' }])).toBe("# keep\n# new\nTOKEN='two$VAR'\nMODE=x # updated\n");
  });
  it('多行和转义值不经表格转换，合法的多行内容仍可原样保存', async () => {
    const { parseDotenvDocument, editDotenvDocument } = await import('../src/lib/dotenv.js');
    for (const raw of ["SECRET='first\nsecond'\nMODE=x\n", 'VALUE="one\\ntwo"\n', "VALUE='it\\'s fine'\n"]) {
      const doc = parseDotenvDocument(raw);
      expect(doc.tableSafe).toBe(false); expect(validateDotenv(raw).ok).toBe(true);
      expect(editDotenvDocument(doc, [{ key: 'OTHER', value: 'oops' }])).toBe(raw);
    }
  });
  it('未闭合引号和引号后垃圾不合法，错误不回显敏感行', () => {
    for (const raw of ["PASSWORD='private-sentinel", 'TOKEN="private-sentinel"garbage', 'private-sentinel']) {
      const result = validateDotenv(raw);
      expect(result.ok).toBe(false); expect(result.errors.join('')).not.toContain('private-sentinel');
    }
  });
});
