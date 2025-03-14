import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import Twilio from "twilio";
import axios from "axios";

dotenv.config();

const fastify = Fastify({ logger: true });
fastify.register(fastifyWebsocket);

const WS_PORT = process.env.WS_PORT || 3001; // Usa un puerto dinámico
const wss = new WebSocketServer({ port: WS_PORT });

console.log(`WebSocket corriendo en el puerto ${WS_PORT}`);

wss.on("connection", (ws) => {
  console.log("Cliente conectado al WebSocket");

  ws.on("message", async (message) => {
    const userText = message.toString();
    console.log(`Usuario dijo: ${userText}`);

    // Obtener respuesta IA con OpenAI
    const aiResponse = await obtenerRespuestaIA(userText);

    // Generar audio con Eleven Labs
    const audioURL = await generarAudio(aiResponse);

    // Enviar URL del audio al WebSocket
    ws.send(JSON.stringify({ audio: audioURL }));
  });
});

// Función para obtener respuesta con IA (GPT-4 o Dialogflow)
async function obtenerRespuestaIA(texto) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4",
      messages: [
        { role: "system", content: "Eres un agente de ventas inmobiliarias." },
        { role: "user", content: texto },
      ],
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    }
  );

  return response.data.choices[0].message.content;
}

// Función para generar audio con Eleven Labs
async function generarAudio(texto) {
  const response = await axios.post(
    "https://api.elevenlabs.io/v1/text-to-speech",
    {
      text: texto,
      voice_id: "nombre-de-la-voz",
      model_id: "eleven_monolingual_v1",
    },
    {
      headers: { Authorization: `Bearer ${process.env.ELEVEN_LABS_API_KEY}` },
      responseType: "json",
    }
  );

  return response.data.audio_url;
}

// Servidor Fastify en Railway
const PORT = process.env.PORT || 3000; // Railway asigna el puerto automáticamente

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Servidor corriendo en ${address}`);
});
