import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

// Cargar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`Servidor WebSocket activo en puerto ${PORT}`)
);

const wss = new WebSocketServer({ server });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

wss.on("connection", (ws) => {
  console.log("Twilio conectado al WebSocket");

  ws.on("message", async (message) => {
    const data = JSON.parse(message);

    if (data.event === "media") {
      console.log("Recibiendo audio de Twilio, enviando a Eleven Labs...");
      await sendToElevenLabs(data.media.payload);
    }
  });

  ws.on("close", () => {
    console.log("Conexión cerrada");
  });
});

// Función para enviar audio a Eleven Labs
async function sendToElevenLabs(audio) {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/agent/audio", {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: ELEVENLABS_AGENT_ID,
        audio_base64: audio,
      }),
    });

    const result = await response.json();
    console.log("Respuesta de Eleven Labs:", result);
  } catch (error) {
    console.error("Error enviando audio a Eleven Labs:", error);
  }
}
