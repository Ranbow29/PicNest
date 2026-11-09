"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const path = require("path");
const fs = require("fs");
const module$1 = require("module");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
function _require() {
  return module$1.createRequire(require("url").pathToFileURL(__filename).href);
}
function getModelDir() {
  const pathMod = require("path");
  const exeDir = require("electron").app.isPackaged ? pathMod.dirname(require("electron").app.getPath("exe")) : process.cwd();
  return pathMod.join(exeDir, "_internal_data", "models", "Xenova", "clip-vit-base-patch32", "onnx");
}
let _visionSession = null;
let _textSession = null;
let _tokenizer = null;
let _initPromise = null;
let _idleTimer = null;
const _IDLE_MS = 5e3;
let _denseWeight = null;
const _DENSE_IN = 768;
const _DENSE_OUT = 512;
const IMAGE_SIZE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
function _resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _visionSession = null;
    _textSession = null;
    _tokenizer = null;
    _initPromise = null;
    _denseWeight = null;
    _idleTimer = null;
    console.log("[clip-search] idle timeout — sessions released");
  }, _IDLE_MS);
}
async function init() {
  if (_visionSession) {
    _resetIdleTimer();
    return;
  }
  if (_initPromise) {
    _resetIdleTimer();
    return _initPromise;
  }
  _initPromise = (async () => {
    const ort = _require()("onnxruntime-node");
    const modelDir = getModelDir();
    const visionBuf = fs__namespace.readFileSync(path__namespace.join(modelDir, "vision_model_quantized.onnx"));
    _visionSession = await ort.InferenceSession.create(visionBuf, { executionProviders: ["cpu"] });
    const textDir = getMultiTextDir();
    const textBuf = fs__namespace.readFileSync(path__namespace.join(textDir, "onnx", "text_model_quantized.onnx"));
    _textSession = await ort.InferenceSession.create(textBuf, { executionProviders: ["cpu"] });
    const wBuf = fs__namespace.readFileSync(path__namespace.join(textDir, "dense_weight.bin"));
    _denseWeight = new Float32Array(wBuf.buffer, wBuf.byteOffset, wBuf.byteLength / 4);
    const { AutoTokenizer, env } = await import("@xenova/transformers");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = textDir;
    _tokenizer = await AutoTokenizer.from_pretrained(".");
  })();
  _initPromise.catch((err) => {
    console.error("[clip-search] init failed, sessions released:", err?.message || err);
    _initPromise = null;
    _visionSession = null;
    _textSession = null;
    _tokenizer = null;
    _denseWeight = null;
    throw err;
  });
  await _initPromise;
  _resetIdleTimer();
}
function getMultiTextDir() {
  const exeDir = _require()("electron").app.isPackaged ? path__namespace.dirname(_require()("electron").app.getPath("exe")) : process.cwd();
  return path__namespace.join(exeDir, "_internal_data", "models", "Multilingual", "clip-text-multilingual");
}
async function computeImageVec(filePath) {
  await init();
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(filePath).removeAlpha().resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const channels = info.channels;
  const float32 = new Float32Array(3 * h * w);
  const area = h * w;
  for (let i = 0, p = 0; i < data.length; i += channels, p++) {
    float32[0 * area + p] = (data[i + 0] / 255 - MEAN[0]) / STD[0];
    float32[1 * area + p] = (data[i + 1] / 255 - MEAN[1]) / STD[1];
    float32[2 * area + p] = (data[i + 2] / 255 - MEAN[2]) / STD[2];
  }
  const ort = _require()("onnxruntime-node");
  const tensor = new ort.Tensor("float32", float32, [1, 3, h, w]);
  const feed = { pixel_values: tensor };
  const out = await _visionSession.run(feed);
  const embeds = out.image_embeds || out[Object.keys(out)[0]];
  let dataOut = embeds.data instanceof Float32Array ? embeds.data : new Float32Array(embeds.data);
  return normalize(dataOut);
}
async function computeTextVec(text) {
  await init();
  const inputs = await _tokenizer(text, { padding: true, truncation: true });
  const seqLen = inputs.input_ids.dims[1];
  const ort = _require()("onnxruntime-node");
  const inputIds = new ort.Tensor("int64", BigInt64Array.from(
    Array.from(inputs.input_ids.data).map(BigInt)
  ), [1, seqLen]);
  const attnMask = new ort.Tensor("int64", BigInt64Array.from(
    Array.from(inputs.attention_mask.data).map(BigInt)
  ), [1, seqLen]);
  const out = await _textSession.run({ input_ids: inputIds, attention_mask: attnMask });
  const hidden = out.last_hidden_state;
  const data = hidden.cpuData ?? hidden.data;
  const pooled = new Float32Array(_DENSE_IN);
  const attn = inputs.attention_mask.data;
  let totalWt = 0;
  for (let t = 0; t < seqLen; t++) {
    const w = Number(attn[t]);
    if (w === 0) continue;
    totalWt += w;
    const off = t * _DENSE_IN;
    for (let h = 0; h < _DENSE_IN; h++) pooled[h] += data[off + h] * w;
  }
  if (totalWt > 0) {
    for (let h = 0; h < _DENSE_IN; h++) pooled[h] /= totalWt;
  }
  const W = _denseWeight;
  const emb = new Float32Array(_DENSE_OUT);
  for (let o = 0; o < _DENSE_OUT; o++) {
    let sum = 0;
    const wOff = o * _DENSE_IN;
    for (let i = 0; i < _DENSE_IN; i++) sum += pooled[i] * W[wOff + i];
    emb[o] = sum;
  }
  return normalize(emb);
}
function normalize(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const inv = 1 / Math.sqrt(Math.max(sum, 1e-12));
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}
async function searchByText(query, clipRows, topN) {
  if (!query.trim()) return [];
  const qVec = await computeTextVec(query);
  const scores = [];
  for (const row of clipRows) {
    if (!row.clip_feat) continue;
    const v = new Float32Array(row.clip_feat.buffer, row.clip_feat.byteOffset, row.clip_feat.byteLength / 4);
    scores.push({ file_path: row.file_path, score: cosine(qVec, v) });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topN);
}
let _send = null;
function setClipSender(send) {
  _send = send;
}
function emitProgress(done, total) {
  try {
    _send?.("clip-index-progress", { done, total });
  } catch {
  }
}
exports.computeImageVec = computeImageVec;
exports.computeTextVec = computeTextVec;
exports.cosine = cosine;
exports.emitProgress = emitProgress;
exports.searchByText = searchByText;
exports.setClipSender = setClipSender;
