#!/usr/bin/env node
// Opt-in real local inference; imports an existing GGUF, never downloads a model.
const fs = require('node:fs/promises');
const path = require('node:path');
const { config } = require('../dist/src/config/config.js');
const { startBackend } = require('../dist/src/index.js');
const { emptyMcpConfiguration } = require('../dist/src/mcp/client/configuration.js');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}
async function main() {
  const modelPath = option('--model-path', process.env.SYNTHESIS_MODEL_PATH);
  if (!modelPath) throw new Error('Pass --model-path /absolute/path/model.gguf. No models are downloaded by this demo.');
  const root = path.resolve(option('--data-dir', '.tmp/synthesis-demo'));
  const projectPath = path.resolve(option('--project', 'examples/synthesis-calculator'));
  const moduleName = option('--module', 'Calculator');
  const port = Number(option('--port', '4317'));
  const serve = process.argv.includes('--serve');
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {...provider, enabled: id === 'llamacpp'}]));
  const options = {
    ...config, appDataDir: path.join(root, 'app'), outputDir: path.join(root, 'output'),
    sessions: {baseDir: path.join(root, 'sessions')},
    memory: {...config.memory, adapter: 'local-json', baseDir: path.join(root, 'memory')},
    mcp: {client: emptyMcpConfiguration(), server: {...config.mcp.server, enabled: false}},
    plugins: {...config.plugins, overrides: {file: {enabled: false}, notion: {enabled: false}}},
    telegram: {...config.telegram, enabled: false}, server: {enabled: serve, host: '127.0.0.1', port},
    providers, llm: {defaultProvider: 'llamacpp'},
    localModels: {...config.localModels, modelsDir: path.join(root, 'models'),
      runtimeDir: path.resolve('resources/llama', `${process.platform}-${process.arch}`), contextSize: 8192, loadTimeoutMs: 300000, generationTimeoutMs: 600000}
  };
  const backend = await startBackend(options);
  let progress;
  const stop = async () => { clearInterval(progress); await backend.dispose(); };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  try {
    const runtime = backend.runtimeManager.getRuntime();
    const model = await runtime.localModelService.importModel([path.resolve(modelPath)]);
    console.log(JSON.stringify({step: 'imported', id: model.id, name: model.displayName, sizeBytes: model.sizeBytes}));
    const projects = await runtime.projectStore.list();
    const project = projects.find(item => item.rootPath === projectPath) ?? await runtime.projectStore.create({name: 'Synthesis calculator demo', rootPath: projectPath});
    if (serve) console.log(`Synthesis UI: http://127.0.0.1:${port}/#/synthesis`);
    const run = await runtime.synthesis.start(project.id, moduleName);
    let sequence = 0;
    let reading = false;
    progress = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const current = await runtime.synthesis.get(run.id);
        for (const event of current.events.filter(item => item.sequence > sequence)) {
          console.log(JSON.stringify(event)); sequence = event.sequence;
        }
      } catch (error) { console.error(error.message); }
      finally { reading = false; }
    }, 1500);
    const result = await runtime.synthesis.wait(run.id);
    clearInterval(progress);
    const diff = await runtime.synthesis.diff(run.id);
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({run: result, diff}, null, 2));
    console.log(JSON.stringify({step: 'finished', id: result.id, status: result.status, iteration: result.iteration,
      models: result.models.map(item => ({id:item.id,name:item.displayName,sizeBytes:item.sizeBytes})), usage:result.usage,
      gates: result.evidence?.gates, error: result.error, report: path.join(root, 'report.json')}));
    if (!serve) { await stop(); if (result.status !== 'accepted') process.exitCode = 1; }
    else console.log('Server stays available for UI inspection. Candidate is NOT applied to the project. Press Ctrl+C to stop.');
  } catch (error) { await stop(); throw error; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
