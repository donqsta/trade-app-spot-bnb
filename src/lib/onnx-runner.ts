/**
 * Wrapper around onnxruntime-node for XGBoost / LightGBM models trained
 * with the Python pipeline in ./ml.
 *
 *  - Lazy-loads onnxruntime-node so the rest of the bot still runs if the
 *    native binary isn't installed (e.g. fresh checkout, before npm install).
 *  - Caches one InferenceSession per pair to amortize the ~200ms model load.
 *  - Returns {signal, confidence} in the SAME shape KNN/Logistic return,
 *    so callers don't care which back-end produced the prediction.
 *
 * Label convention (must match ml/train.py):
 *   class 0 = SHORT  (original -1)
 *   class 1 = HOLD   (original  0)
 *   class 2 = LONG   (original +1)
 */

import path from 'path';
import fs from 'fs';

interface InferenceSession {
    inputNames: string[];
    outputNames: string[];
    run(feeds: Record<string, any>): Promise<Record<string, any>>;
}

interface OnnxRuntime {
    InferenceSession: { create(p: string): Promise<InferenceSession> };
    Tensor: new (type: string, data: any, dims: number[]) => any;
}

let _ort: OnnxRuntime | null = null;
let _ortLoadFailed = false;

async function loadOrt(): Promise<OnnxRuntime | null> {
    if (_ort) return _ort;
    if (_ortLoadFailed) return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        _ort = require('onnxruntime-node') as OnnxRuntime;
        return _ort;
    } catch {
        _ortLoadFailed = true;
        return null;
    }
}

// Cache InferenceSession + the file mtime that produced it. When the trainer
// container writes a fresh .onnx to the shared volume we want the bot to
// pick it up automatically, without a process restart.
interface SessionEntry { session: InferenceSession; mtimeMs: number }
const sessions = new Map<string, SessionEntry>();

export interface OnnxPrediction { signal: -1 | 0 | 1; confidence: number }

/**
 * Resolve the directory where ONNX models live.
 *  - In Docker: `BOT_MODEL_DIR=/models` and a volume is mounted there. The
 *    trainer service writes into it; the app reads from it.
 *  - Locally:   defaults to `<cwd>/ml/models`, matching the output of ml/train.py.
 */
function modelDir(): string {
    const env = (typeof process !== 'undefined' && process.env?.BOT_MODEL_DIR) || '';
    if (env) return env;
    return path.join(/*turbopackIgnore: true*/ process.cwd(), 'ml', 'models');
}

/**
 * Resolve the ONNX model file path.
 * Naming convention (timeframe-aware):
 *   Primary:  {PAIR}_{timeframe}_{kind}.onnx  e.g. BTCUSDT_15m_xgboost.onnx
 *   Fallback: {PAIR}_{kind}.onnx              e.g. BTCUSDT_xgboost.onnx  (legacy, no TF suffix)
 *
 * The fallback exists for backward compatibility with models trained before
 * the timeframe-aware naming was introduced. The caller should prefer the
 * primary path; if it is missing the bot will use the legacy file and also
 * trigger a retrain so the timeframe-specific model gets created.
 */
function modelPath(pair: string, kind: 'xgboost' | 'lightgbm' = 'xgboost', timeframe?: string): string {
    const base = modelDir();
    if (timeframe) {
        return path.join(base, `${pair.toUpperCase()}_${timeframe}_${kind}.onnx`);
    }
    return path.join(base, `${pair.toUpperCase()}_${kind}.onnx`);
}

/**
 * Check if an ONNX model exists for the given pair, kind, and optional timeframe.
 * When timeframe is provided, checks the timeframe-specific file first.
 */
export function hasOnnxModel(pair: string, kind: 'xgboost' | 'lightgbm' = 'xgboost', timeframe?: string): boolean {
    try {
        if (timeframe && fs.existsSync(modelPath(pair, kind, timeframe))) return true;
        return fs.existsSync(modelPath(pair, kind)); // legacy fallback
    } catch { return false; }
}

/**
 * Returns age of the ONNX model file in hours, or null if no model exists.
 * Uses the file mtime so it reflects when the last successful training finished.
 */
export function onnxModelAgeHours(pair: string, kind: 'xgboost' | 'lightgbm' = 'xgboost', timeframe?: string): number | null {
    try {
        const primary = timeframe ? modelPath(pair, kind, timeframe) : null;
        const legacy = modelPath(pair, kind);
        const filePath = primary && fs.existsSync(primary) ? primary : (fs.existsSync(legacy) ? legacy : null);
        if (!filePath) return null;
        const stat = fs.statSync(filePath);
        return (Date.now() - stat.mtimeMs) / 3_600_000;
    } catch { return null; }
}

async function getSession(pair: string, kind: 'xgboost' | 'lightgbm', timeframe?: string): Promise<InferenceSession | null> {
    const key = `${pair}:${kind}:${timeframe ?? 'legacy'}`;
    // Prefer timeframe-specific model; fall back to legacy if not yet trained.
    const p = timeframe && fs.existsSync(modelPath(pair, kind, timeframe))
        ? modelPath(pair, kind, timeframe)
        : modelPath(pair, kind);

    let currentMtime = 0;
    try {
        const st = fs.statSync(p);
        currentMtime = st.mtimeMs;
    } catch {
        return null; // file missing
    }

    // Hot-reload: if the trainer just wrote a fresher .onnx, drop the cached
    // session and rebuild against the new file. Cheap because mtime is O(1).
    const cached = sessions.get(key);
    if (cached && cached.mtimeMs === currentMtime) return cached.session;

    const ort = await loadOrt();
    if (!ort) return null;
    try {
        const s = await ort.InferenceSession.create(p);
        sessions.set(key, { session: s, mtimeMs: currentMtime });
        return s;
    } catch {
        return null;
    }
}

/** Force-drop all cached sessions (useful for tests / manual reloads). */
export function clearOnnxCache(): void {
    sessions.clear();
}

/**
 * Run inference. Features should match whatever schema the ONNX model was
 * trained on:
 *   - 10-d: legacy schema (RSI..BBSpread).
 *   - 15-d: T3.1 enriched schema (10 base + funding/OI/HTF/volRegime/btcCorr).
 * If the caller hands in 15 features but the model expects 10, we
 * transparently truncate. This means a stale ONNX model still works after
 * the bot upgrades — no hard restart needed, just lower edge until retrain.
 * Returns null on any failure so callers can fall back to their old model.
 */
const expectedDimByKey = new Map<string, number>();

async function runWithDims(
    ort: OnnxRuntime,
    session: InferenceSession,
    features: number[]
) {
    const input = new ort.Tensor('float32', Float32Array.from(features), [1, features.length]);
    const inputName = session.inputNames[0] || 'input';
    return session.run({ [inputName]: input });
}

export async function predictONNX(
    pair: string,
    features: number[],
    kind: 'xgboost' | 'lightgbm' = 'xgboost',
    timeframe?: string
): Promise<OnnxPrediction | null> {
    const ort = await loadOrt();
    if (!ort) return null;
    const session = await getSession(pair, kind, timeframe);
    if (!session) return null;

    const key = `${pair}:${kind}:${timeframe ?? 'legacy'}`;
    let inputFeatures = features;
    const known = expectedDimByKey.get(key);
    if (known && known !== inputFeatures.length) {
        inputFeatures = inputFeatures.slice(0, known);
    }

    let result: Record<string, any>;
    try {
        result = await runWithDims(ort, session, inputFeatures);
    } catch {
        // Likely dim mismatch — retry truncating to 10 (legacy schema).
        if (inputFeatures.length > 10) {
            try {
                inputFeatures = features.slice(0, 10);
                result = await runWithDims(ort, session, inputFeatures);
                expectedDimByKey.set(key, 10);
            } catch {
                return null;
            }
        } else {
            return null;
        }
    }

    if (!expectedDimByKey.has(key)) expectedDimByKey.set(key, inputFeatures.length);

    try {

        // Tree-model ONNX exports usually expose two outputs:
        //   - label    (Int64Tensor)
        //   - probabilities (Float32Tensor [N, num_classes])
        // We always prefer probabilities so we get a calibrated confidence.
        let probs: Float32Array | null = null;
        for (const name of session.outputNames) {
            const t = result[name];
            if (!t) continue;
            const dims = t.dims || [];
            if (dims.length === 2 && (dims[1] === 3 || dims[1] === 2)) {
                probs = t.data as Float32Array;
                break;
            }
            // LightGBM via onnxmltools can emit a SequenceMap. Best-effort decode:
            if (Array.isArray(t.data) && t.data[0] && typeof t.data[0] === 'object') {
                const obj = t.data[0] as Record<string, number>;
                if ('2' in obj) {
                    probs = Float32Array.from([obj['0'] || 0, obj['1'] || 0, obj['2'] || 0]);
                } else {
                    probs = Float32Array.from([obj['0'] || 0, obj['1'] || 0]);
                }
                break;
            }
        }

        if (!probs || probs.length < 2) return null;
        let signal: -1 | 0 | 1 = 0;
        let confidence = 50;

        if (probs.length === 2) {
            // Binary classifier: class 0 = HOLD, class 1 = LONG
            const [pHold, pLong] = [probs[0], probs[1]];
            if (pLong > pHold) {
                signal = 1;
                confidence = Math.round(pLong * 100);
            } else {
                signal = 0;
                confidence = Math.round(pHold * 100);
            }
        } else {
            // Multiclass classifier (legacy): class 0 = SHORT, class 1 = HOLD, class 2 = LONG
            const [pShort, pHold, pLong] = [probs[0], probs[1], probs[2]];
            if (pLong > pShort && pLong > pHold) {
                signal = 1;
                confidence = Math.round(pLong * 100);
            } else {
                // Map SHORT prediction to HOLD
                signal = 0;
                const maxHoldOrShort = Math.max(pShort, pHold);
                confidence = Math.round(maxHoldOrShort * 100);
            }
        }
        return { signal, confidence };
    } catch {
        return null;
    }
}

export function clearOnnxDimCache(): void {
    expectedDimByKey.clear();
}
