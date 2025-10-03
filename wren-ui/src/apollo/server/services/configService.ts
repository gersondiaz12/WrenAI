import fs from 'fs/promises';
import yaml from 'js-yaml';
import path from 'path';
import os from 'os';

const DEFAULT_CONFIG_PATH = process.env.PROJECT_CONFIG_PATH || path.join(process.cwd(), 'config.yaml');

export class ConfigService {
  async readConfig() {
    const homedirDir = path.join(os.homedir(), '.wrenai');
    const homedirConfig = path.join(homedirDir, 'config.yaml');

    // candidate order: explicit env, homedir, project, repo-root
    const candidates = [process.env.PROJECT_CONFIG_PATH, homedirConfig, DEFAULT_CONFIG_PATH, path.join(process.cwd(), '..', 'config.yaml')].filter(Boolean) as string[];

    let lastErr: any = null;
    for (const p of candidates) {
      try {
        const raw = await fs.readFile(p, 'utf8');
        // If we read from a project-local config and there is no homedir config, migrate it to ~/.wrenai/config.yaml
        if (p === DEFAULT_CONFIG_PATH) {
          try {
            // create homedir and copy file only if homedir config doesn't exist
            try {
              await fs.access(homedirConfig);
            } catch (e) {
              await fs.mkdir(homedirDir, { recursive: true });
              await fs.writeFile(homedirConfig, raw, { encoding: 'utf8' });
              // remove project-local config to avoid accidental commits
              try {
                await fs.unlink(DEFAULT_CONFIG_PATH);
              } catch (e) {}
              // eslint-disable-next-line no-console
              console.info('[ConfigService] migrated project config to', homedirConfig);
            }
          } catch (e) {
            // ignore migration errors
          }
        }

        return yaml.loadAll(raw);
      } catch (err: any) {
        lastErr = err;
        // continue to next candidate
      }
    }
    // If none of the candidates exist, create a default homedir config so dev has a sane default
    try {
      const homedirDir = path.join(os.homedir(), '.wrenai');
      const homedirConfig = path.join(homedirDir, 'config.yaml');
      await fs.mkdir(homedirDir, { recursive: true });
      const defaultYaml = `---\n- type: llm\n  provider: openai\n  api_base: https://api.openai.com/v1\n  models:\n    - model: gpt-4o-mini\n  active_model: gpt-4o-mini\n`;
      await fs.writeFile(homedirConfig, defaultYaml, { encoding: 'utf8' });
      return yaml.loadAll(defaultYaml);
    } catch (e) {
      // If creation fails, rethrow the last read error for visibility
      throw lastErr || e || new Error('config.yaml not found and default creation failed');
    }
  }

  async writeConfig(docs: any[]) {
    // Basic validation: ensure LLM config exists
    if (!docs.some(d => d?.type === 'llm')) throw new Error('No llm doc found');
    const serialized = docs.map(d => yaml.dump(d)).join('---\n');
    const homedirDir = path.join(os.homedir(), '.wrenai');
    const homedirConfig = path.join(homedirDir, 'config.yaml');
    try {
      await fs.mkdir(homedirDir, { recursive: true });
    } catch (e) {}
    await fs.writeFile(homedirConfig, serialized, { encoding: 'utf8' });
    return docs;
  }
}
