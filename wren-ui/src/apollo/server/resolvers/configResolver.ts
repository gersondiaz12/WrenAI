import { ConfigService } from '../services/configService';
import { IContext } from '../types';
import axios from 'axios';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getLogger } from '@server/utils';

const logger = getLogger('ConfigResolver');

type LLMDoc = any;

export class ConfigResolver {
  private configService: ConfigService;

  constructor() {
    this.configService = new ConfigService();
  }

  async getLLMConfig(_root: any, _args: any, ctx: IContext) {
    const docs = await this.configService.readConfig();
    const llmDocs = docs.filter((d: any) => d && d.type === 'llm');
    // mask secrets in returned docs
    const masked = (llmDocs.length ? llmDocs : docs).map((d: LLMDoc) => maskSecrets(d));
    return masked;
  }

  async updateLLMConfig(_root: any, args: { data: any }, ctx: IContext) {
    // require admin access
    const isAdmin = ctx.isAdmin || (ctx.req && (ctx.req as any).__isAdmin) || false;
    if (!isAdmin) {
      throw new Error('Unauthorized: admin required to update LLM configuration');
    }
    const incoming = { ...(args.data || {}) };
    // persistKey semantics: if persistKey === false, never persist the provided key anywhere
    const wantsPersist = incoming.persistKey !== false;

    // If user does NOT want to persist, remove any raw key fields to ensure they are not written to YAML
    if (!wantsPersist) {
      delete incoming.api_key;
      delete incoming.apiKey;
      // also ensure we do not accidentally write a reference
      delete incoming.api_key_env;
    } else {
      // User wants persistence: if a key is provided, attempt to write it to homedir .env and remove raw key
      if (incoming.api_key || incoming.apiKey) {
        const keyValue = incoming.api_key || incoming.apiKey;
        const envVar = chooseEnvVarName(incoming);
        try {
          await writeEnvVar(envVar, keyValue);
          // set a reference in config so humans know where the key is stored
          incoming.api_key_env = envVar;
          delete incoming.api_key;
          delete incoming.apiKey;
        } catch (e: any) {
          // Fail early: do not write YAML containing the raw key
          throw new Error('Failed to persist API key to homedir .env: ' + (e?.message || String(e)));
        }
      }
    }
    const docs = await this.configService.readConfig();

    let hasReplaced = false;
    const newDocs = docs.map((d: any) => {
      if (d && d.type === 'llm') {
        hasReplaced = true;
        // merge shallowly to keep other fields if present; ensure active_model is preserved
        const merged = { ...d, ...incoming };
        if (incoming.active_model === undefined && d.active_model) merged.active_model = d.active_model;
        return merged;
      }
      return d;
    });
    if (!hasReplaced) newDocs.push(incoming);

    await this.configService.writeConfig(newDocs);
    return incoming;
  }

  async testLLMConnection(_root: any, args: { data: any }, ctx: IContext) {
    const isAdmin = ctx.isAdmin || (ctx.req && (ctx.req as any).__isAdmin) || false;
    // allow non-admin users to test but with no persisted reads; tests should
    // prefer provided key in payload
    const data = args.data as LLMDoc;
    // Basic test: for OpenAI-like providers, make a small request to models endpoint
    try {
      const provider = (data.provider || '').toLowerCase();
      const apiBase = data.api_base || 'https://api.openai.com/v1';
      const models = data.models || [];

      // resolve API key: prefer provided value, then env var reference in doc, then common env vars
      let apiKey = data.api_key || data.apiKey || undefined;
      if (!apiKey && data.api_key_env) {
        apiKey = process.env[data.api_key_env];
      }
      if (!apiKey) {
        // try a set of common env var names
        apiKey = process.env['AZURE_OPENAI_API_KEY'] || process.env['OPENAI_API_KEY'] || process.env['DEEPSEEK_API_KEY'] || process.env['OPENROUTER_API_KEY'];
      }

      if (!apiKey) return { ok: false, error: 'No API key provided or found in environment' };

  // Provider-specific test branches
  // Azure-specific test
      if (provider.includes('azure') || data.api_version || (apiBase && apiBase.includes('.openai.azure.com'))) {
        // Need deployment name and api_version
        const apiVersion = data.api_version || '2024-02-15-preview';
        const firstModel = models[0]?.model;
        if (!firstModel) return { ok: false, error: 'No deployment/model specified for Azure test' };
        // model may be like 'azure/<deployment>' or just deployment name
        const deployment = firstModel.includes('/') ? firstModel.split('/').pop() : firstModel;
        const url = apiBase.endsWith('/') ? `${apiBase}openai/deployments/${deployment}/completions?api-version=${apiVersion}` : `${apiBase}/openai/deployments/${deployment}/completions?api-version=${apiVersion}`;
        // send a small completion request
        const body = { prompt: 'hello', max_tokens: 1 };
        const resp = await axios.post(url, body, {
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: 7000,
        });
        if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status, data: resp.data };
        return { ok: false, status: resp.status };
      }
      // OpenRouter: POST to /v1/completions with key in Authorization Bearer or x-openrouter-key
      if (provider.includes('openrouter') || (apiBase && apiBase.includes('openrouter'))) {
        try {
          const url = apiBase.endsWith('/') ? apiBase + 'v1/models' : apiBase + '/v1/models';
          const resp = await axios.get(url, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            timeout: 5000,
          });
          if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status, data: resp.data };
          return { ok: false, status: resp.status };
        } catch (e: any) {
          return { ok: false, error: e.message || String(e) };
        }
      }

      // Ollama: health endpoint at /api/ping
      if (provider.includes('ollama') || (apiBase && apiBase.includes('ollama'))) {
        try {
          const url = apiBase.endsWith('/') ? apiBase + 'api/ping' : apiBase + '/api/ping';
          const resp = await axios.get(url, { timeout: 4000 });
          if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status, data: resp.data };
          return { ok: false, status: resp.status };
        } catch (e: any) {
          return { ok: false, error: e.message || String(e) };
        }
      }

      // Deepseek (example): GET /v1/models
      if (provider.includes('deepseek') || (apiBase && apiBase.includes('deepseek'))) {
        try {
          const url = apiBase.endsWith('/') ? apiBase + 'v1/models' : apiBase + '/v1/models';
          const resp = await axios.get(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 5000,
          });
          if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status, data: resp.data };
          return { ok: false, status: resp.status };
        } catch (e: any) {
          return { ok: false, error: e.message || String(e) };
        }
      }

      // Generic OpenAI-like test: GET /models
      {
        try {
          const url = apiBase.endsWith('/') ? apiBase + 'models' : apiBase + '/models';
          const resp = await axios.get(url, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            timeout: 5000,
          });
          if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status, data: resp.data };
          return { ok: false, status: resp.status };
        } catch (e: any) {
          return { ok: false, error: e.message || String(e) };
        }
      }
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  async switchLLMNow(_root: any, args: { data: any }, ctx: IContext) {
    const isAdmin = ctx.isAdmin || (ctx.req && (ctx.req as any).__isAdmin) || false;
    logger.info('switchLLMNow called, isAdmin=' + Boolean(isAdmin));
    if (!isAdmin) {
      logger.warn('Unauthorized switchLLMNow attempt');
      throw new Error('Unauthorized: admin required to switch LLM now');
    }
    const incoming = { ...(args.data || {}) };
    logger.debug('switchLLMNow incoming payload: ' + JSON.stringify(incoming));
    // read current docs and merge active_model if provided
    const docs = await this.configService.readConfig();
    let llmDoc = docs.find((d: any) => d && d.type === 'llm');
    if (!llmDoc) {
      llmDoc = { type: 'llm' };
      docs.push(llmDoc);
    }
    // merge shallow incoming fields (but do not persist here)
    Object.assign(llmDoc, incoming);

    // ask the runtime adaptor to reinitialize
    try {
      // lazy import components to avoid circular deps
      logger.info('Attempting to call runtime adaptor reinitialize');
      const { components } = require('@/common');
      const adaptor = components?.wrenAIAdaptor;
      if (adaptor && typeof adaptor.reinitializeFromLLM === 'function') {
        await adaptor.reinitializeFromLLM(llmDoc);
        logger.info('Adaptor reinitializeFromLLM succeeded');
        return { ok: true };
      } else {
        logger.warn('Adaptor does not support reinitialization');
        return { ok: false, error: 'Adaptor does not support reinitialization' };
      }
    } catch (e: any) {
      logger.error('switchLLMNow error: ' + (e?.message || String(e)));
      return { ok: false, error: e.message || String(e) };
    }
  }
}

function maskSecrets(doc: LLMDoc) {
  if (!doc) return doc;
  const copy = JSON.parse(JSON.stringify(doc));
  // common secret keys
  const secretKeys = ['api_key', 'apiKey', 'key', 'secret', 'password', 'token'];
  if (Array.isArray(copy.models)) {
    copy.models = copy.models.map((m: any) => {
      const mcopy = { ...m };
      // mask any model-level secret
      secretKeys.forEach((k) => {
        if (mcopy[k]) mcopy[k] = '*****';
      });
      return mcopy;
    });
  }
  secretKeys.forEach((k) => {
    if (copy[k]) copy[k] = '*****';
  });
  // expose env var reference if present
  if (copy.api_key_env) {
    copy.api_key_env = copy.api_key_env;
  }
  // preserve active_model field for UI
  if (copy.active_model) {
    copy.active_model = copy.active_model;
  }
  return copy;
}

function chooseEnvVarName(doc: LLMDoc) {
  const provider = (doc.provider || '').toString().toLowerCase();
  if (provider.includes('azure') || doc.api_version || (doc.api_base && doc.api_base.includes('.openai.azure.com'))) return 'AZURE_OPENAI_API_KEY';
  if (provider.includes('deepseek')) return 'DEEPSEEK_API_KEY';
  if (provider.includes('openrouter')) return 'OPENROUTER_API_KEY';
  if (provider.includes('ollama')) return 'OLLAMA_API_KEY';
  if (provider.includes('google') || provider.includes('vertex')) return 'GOOGLE_API_KEY';
  // default
  return 'OPENAI_API_KEY';
}

async function writeEnvVar(varName: string, value: string) {
  const dir = path.join(os.homedir(), '.wrenai');
  const envPath = path.join(dir, '.env');
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {}
  let content = '';
  try {
    content = await fs.readFile(envPath, 'utf8');
  } catch (e) {
    content = '';
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const kv: Record<string, string> = {};
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      kv[k] = v;
    }
  }
  kv[varName] = value;
  const out = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n');
  await fs.writeFile(envPath, out, { encoding: 'utf8' });
}

export default new ConfigResolver();
