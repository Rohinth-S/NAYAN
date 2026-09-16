import { createWorker, type Worker } from 'tesseract.js';
import { BinaryBitmap, HybridBinarizer, MultiFormatReader, NotFoundException, RGBLuminanceSource } from '@zxing/library';
import { runtimeUrl } from './webext';
import type { Entity, OcrRegion, PerceptionRuntime } from './perception';

export function createBrowserPerceptionRuntime(): PerceptionRuntime {
  let ocrWorker: Promise<Worker> | undefined;
  let ner: Promise<(text: string) => Promise<readonly Entity[]>> | undefined;
  let disposeNer: (() => Promise<void>) | undefined;
  function worker() {
    ocrWorker ??= createWorker(['eng', 'hin'], 1, {
      workerPath: runtimeUrl('perception/worker.min.js'),
      corePath: runtimeUrl('perception/core'),
      langPath: runtimeUrl('perception/lang-data'),
      workerBlobURL: false, gzip: false, cacheMethod: 'none',
      logger: () => undefined, errorHandler: () => undefined,
    });
    return ocrWorker;
  }
  function classifier() {
    ner ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = runtimeUrl('perception/models/');
      env.useBrowserCache = false;
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = runtimeUrl('perception/ner-wasm/');
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
      }
      const model = await pipeline('token-classification', 'Xenova/bert-base-multilingual-cased-ner-hrl', {
        dtype: 'q8', device: 'wasm', local_files_only: true,
      });
      disposeNer = () => model.dispose();
      return async (text: string) => {
        const tokens = await model.tokenizer(text, { truncation: false });
        if (tokens.input_ids.size > 512) throw new Error('Local NER token budget exceeded');
        const result = await model(text, { ignore_labels: ['O'] });
        if (!Array.isArray(result)) throw new Error('Invalid NER result');
        return result as readonly Entity[];
      };
    })();
    return ner;
  }
  return {
    async entities(text) { return (await classifier())(text); },
    async ocr(image): Promise<readonly OcrRegion[]> {
      const result = await (await worker()).recognize(image, {}, { blocks: true });
      if (!Array.isArray(result.data.blocks)) throw new Error('OCR geometry unavailable');
      return result.data.blocks.flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.map(line => ({
        text: line.text, confidence: line.confidence / 100,
        bounds: { x: line.bbox.x0, y: line.bbox.y0, width: line.bbox.x1 - line.bbox.x0, height: line.bbox.y1 - line.bbox.y0 },
      }))));
    },
    async barcodes(image) {
      const context = image.getContext('2d');
      if (!context) throw new Error('Local canvas unavailable');
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      const gray = new Uint8ClampedArray(image.width * image.height);
      for (let i = 0; i < gray.length; i++) gray[i] = Math.round((rgba[i * 4]! + 2 * rgba[i * 4 + 1]! + rgba[i * 4 + 2]!) / 4);
      const reader = new MultiFormatReader();
      try {
        const code = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(gray, image.width, image.height))));
        const points = code.getResultPoints();
        if (!points.length) throw new Error('Barcode geometry unavailable');
        const left = Math.max(0, Math.min(...points.map(p => p.getX())) - 24);
        const top = Math.max(0, Math.min(...points.map(p => p.getY())) - 24);
        const right = Math.min(image.width, Math.max(...points.map(p => p.getX())) + 24);
        const bottom = Math.min(image.height, Math.max(...points.map(p => p.getY())) + 24);
        // Never keep code.getText(): all codes stay covered by whole-media masks.
        return [{ x: left, y: top, width: right - left, height: bottom - top }];
      } catch (error) {
        if (error instanceof NotFoundException) return [];
        throw new Error('Local barcode detection failed');
      } finally { reader.reset(); }
    },
    async close() {
      // Do not let a stuck initialization delay the fail-closed response.
      const pendingWorker = ocrWorker;
      const pendingNer = ner;
      ocrWorker = undefined;
      ner = undefined;
      void pendingWorker?.then(w => w.terminate()).catch(() => undefined);
      void pendingNer?.then(() => disposeNer?.()).catch(() => undefined);
    },
  };
}
