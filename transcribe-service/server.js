require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const { transcribeAudioFile } = require("./transcribe");

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 25 * 1024 * 1024 } });

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  const secret = process.env.TRANSCRIBE_SECRET;
  if (secret && req.headers["x-secret"] !== secret) {
    return res.status(401).json({ error: "no autorizado" });
  }
  if (!req.file) return res.status(400).json({ error: "falta el archivo audio" });

  try {
    const text = await transcribeAudioFile(req.file.path);
    res.json({ text });
  } catch (err) {
    console.error("Error transcribiendo:", err);
    res.status(500).json({ error: "fallo la transcripcion" });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`Servicio de transcripcion de corcho escuchando en :${PORT}`);
});
