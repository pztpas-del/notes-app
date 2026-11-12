// Background worker: turns note texts into "meaning vectors" with a small
// multilingual neural network (multilingual-e5-small) that runs on this device.
// The model (~120 MB) is downloaded once from Hugging Face and then kept by the
// browser; notes never leave the device.
import { pipeline, env } from '../vendor/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1; // GitHub Pages cannot enable threads; one is enough

const MODEL = 'Xenova/multilingual-e5-small';
let extractor = null;

async function load() {
  if (!extractor) {
    const files = {};
    extractor = await pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      progress_callback: p => {
        if (p.status === 'progress' && p.file) {
          files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
          const all = Object.values(files);
          postMessage({ type: 'download', loaded: all.reduce((s, f) => s + f.loaded, 0), total: all.reduce((s, f) => s + f.total, 0) });
        }
      },
    });
  }
  return extractor;
}

onmessage = async e => {
  const { id, texts } = e.data;
  try {
    const ex = await load();
    const vectors = [];
    for (let i = 0; i < texts.length; i += 4) {
      const out = await ex(texts.slice(i, i + 4), { pooling: 'mean', normalize: true });
      vectors.push(...out.tolist());
      postMessage({ type: 'step', id, done: Math.min(i + 4, texts.length), total: texts.length });
    }
    postMessage({ type: 'result', id, vectors });
  } catch (err) {
    postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};
