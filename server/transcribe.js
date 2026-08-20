const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");

let transcriberPromise = null;

function getTranscriber() {
  if (!transcriberPromise) {
    const modelId = process.env.WHISPER_MODEL || "Xenova/whisper-base";
    console.log(`Cargando modelo Whisper "${modelId}" (la primera vez descarga los pesos)...`);
    transcriberPromise = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("automatic-speech-recognition", modelId)
    );
  }
  return transcriberPromise;
}

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
    const transcriber = await getTranscriber();
    const language = process.env.WHISPER_LANGUAGE || "spanish";
    const result = await transcriber(audio, { language, task: "transcribe" });
    return (result.text || "").trim();
  } finally {
    fs.unlink(wavPath, () => {});
  }
}

module.exports = { transcribeAudioFile };
