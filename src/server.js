import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, classifyError } from './app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 4173);
const DATA_FILE = process.env.FIELDSCOPE_DB ?? join(ROOT, 'data', 'fieldscope.sqlite');

const { api } = createApp({
  dbFile: DATA_FILE,
  latencyChunkMs: Number(process.env.CHUNK_LATENCY_MS ?? 220)
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const E = (status, body) => ({ __status: status, body });

function route(method, path) {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;
  const [, a, b, c] = parts;

  if (a === 'meta' && method === 'GET') return () => api.meta();
  if (a === 'state' && method === 'GET') return () => api.state(b);
  if (a === 'purposes' && method === 'GET') return () => api.authz.snapshot();

  if (a === 'purposes' && b && method === 'PATCH') {
    return (body) => {
      if (!body || !Array.isArray(body.fields)) throw Object.assign(new Error('需要 fields 数组'), { code: 'E_FIELD_INVALID' });
      return api.setFields(b, body.fields);
    };
  }

  if (a === 'plan' && b && method === 'GET') return () => api.planPreview(b);

  if (a === 'jobs' && b == null && method === 'POST') {
    return async (body) => api.runJob(body ?? {});
  }
  if (a === 'jobs' && b && c == null && method === 'GET') {
    return () => {
      const job = api.collector.getJob(b);
      if (!job) throw Object.assign(new Error('任务不存在'), { code: 'E_JOB_UNKNOWN' });
      return job;
    };
  }

  if (a === 'source' && b === 'catalog' && method === 'GET') return () => api.source.catalog();
  if (a === 'source' && b === 'chunks' && method === 'GET') return (_, url) => {
    const purpose = url.searchParams.get('purpose');
    return api.receiver.listChunks(purpose);
  };
  if (a === 'source' && b === 'requests' && method === 'GET') return () => ({
    requests: api.source.requests.slice(-40),
    reportedFields: [...api.source.reportedFields]
  });

  if (a === 'index' && b && method === 'POST') {
    return async (body) => api.commitIndex({ purpose: b, jobId: body?.jobId ?? null });
  }
  if (a === 'query' && b && method === 'POST') {
    return (body) => api.indexer.query({ purpose: b, fields: body?.fields, search: body?.search ?? '' });
  }

  if (a === 'exports' && method === 'GET') return () => api.exporter.history(b ?? null);
  if (a === 'exports' && method === 'POST') {
    return (body) => api.exporter.export({ purpose: body?.purpose, fields: body?.fields, format: body?.format ?? 'json' });
  }
  return undefined;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('请求体过大'), { code: 'E_FIELD_INVALID' });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'E_BODY_INVALID' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const handler = route(req.method, url.pathname);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code: 'E_ROUTE', message: '接口不存在' } }));
      return;
    }
    try {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const data = await handler(body, url);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (err) {
      const { status, body } = classifyError(err);
      api.store.audit('api.error', null, 'error', body.error.code, { path: url.pathname, message: body.error.message });
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    }
    return;
  }

  const root = WEB.endsWith('/') ? WEB : `${WEB}/`;
  const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  // 必须落在 web/ 目录内，防止 ../ 读取工作区其他文件。
  if (file !== WEB && !file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const content = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FieldScope Lab 运行于 http://127.0.0.1:${PORT}`);
  console.log(`数据库：${DATA_FILE}`);
  console.log('全部数据为虚构演练数据；来源、接收与索引均在本地完成。');
});
