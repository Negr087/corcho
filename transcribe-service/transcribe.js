const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");

let transcriberPromise = null;

async function loadTranscriber() {
  const modelId = process.env.WHISPER_MODEL || "Xenova/whisper-base";
  console.log(`Cargando modelo Whisper "${modelId}"...`);
  const { pipeline, env } = await import("@huggingface/transformers");
  try {
    const t = await pipeline("automatic-speech-recognition", modelId);
    console.log(`Modelo Whisper "${modelId}" listo.`);
    return t;
  } catch (err) {
    transcriberPromise = null;
    // La descarga puede haber quedado truncada (bug conocido con el
    // backend de almacenamiento "Xet" de HuggingFace: no valida que el
    // archivo .onnx se haya bajado completo antes de cachearlo). Si no
    // borramos ese cache roto, todos los reintentos van a releer el mismo
    // archivo incompleto y fallar siempre igual.
    try {
      const cacheDir = path.join(env.cacheDir, modelId);
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.error(`Cache de "${modelId}" parece corrupto, lo borre para reintentar desde cero.`);
    } catch (cleanupErr) {
      console.error("No se pudo limpiar el cache corrupto:", cleanupErr.message);
    }
    throw err;
  }
}

function getTranscriber() {
  if (!transcriberPromise) transcriberPromise = loadTranscriber();
  return transcriberPromise;
}

getTranscriber().catch((err) => console.error("No se pudo precargar Whisper:", err.message));

function convertToWav(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + ".wav";
    const args = ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outputPath];
    const proc = spawn(ffmpegPath, args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error("ffmpeg fallo: " + stderr));
    });
  });
}

function wavToFloat32(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset < buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset === -1) throw new Error("WAV sin chunk de datos");
  const numSamples = dataSize / 2;
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return float32;
}

async function transcribeAudioFile(inputPath) {
  const wavPath = await convertToWav(inputPath);
  try {
    const audio = wavToFloat32(wavPath);
    const language = process.env.WHISPER_LANGUAGE || "spanish";
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const transcriber = await getTranscriber();
        const result = await transcriber(audio, { language, task: "transcribe" });
        return (result.text || "").trim();
      } catch (err) {
        lastErr = err;
        console.error(`Transcripcion, intento ${attempt}/${MAX_ATTEMPTS} fallo:`, err.message);
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

module.exports = { transcribeAudioFile };
