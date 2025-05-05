import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import pkg from "@supabase/supabase-js";

const { createClient } = pkg;

dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  PORT = 8000,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
  throw new Error("Missing Supabase config");
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

fastify.post("/outbound-call", async (req, reply) => {
  const {
    number,
    prompt,
    first_message,
    client_name,
    client_phone,
    client_email,
    client_id,
  } = req.body;

  if (!number)
    return reply.code(400).send({ error: "Phone number is required" });

  const date = new Date();
  const fecha = `${date.getDate().toString().padStart(2, "0")}/${(
    date.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}/${date.getFullYear().toString().slice(-2)}`;
  const diasSemana = [
    "Domingo",
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
  ];
  const dia_semana = diasSemana[date.getDay()];

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        req.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(
        first_message
      )}&client_name=${encodeURIComponent(
        client_name
      )}&client_phone=${encodeURIComponent(
        client_phone
      )}&client_email=${encodeURIComponent(
        client_email
      )}&client_id=${encodeURIComponent(client_id)}&fecha=${encodeURIComponent(
        fecha
      )}&dia_semana=${encodeURIComponent(dia_semana)}`,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error initiating call:", err);
    reply.code(500).send({ success: false, error: "Failed to initiate call" });
  }
});

fastify.all("/outbound-call-twiml", async (req, reply) => {
  const p = req.query;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/outbound-media-stream">
      ${Object.keys(p)
        .map((key) => `<Parameter name="${key}" value="${p[key]}" />`)
        .join("\n")}
    </Stream>
  </Connect>
</Response>`;
  reply.type("text/xml").send(xml);
});

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.log("[WS] New media stream connected");
      let streamSid,
        callSid,
        elevenLabsWs,
        customParams,
        lastTranscript = "",
        callStartTime;

      const setupElevenLabs = async () => {
        const signedUrl = await fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
          {
            headers: { "xi-api-key": ELEVENLABS_API_KEY },
          }
        )
          .then((res) => res.json())
          .then((r) => r.signed_url);

        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected");
          callStartTime = new Date();

          elevenLabsWs.send(
            JSON.stringify({
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: { agent_id: ELEVENLABS_AGENT_ID },
                keep_alive: true,
              },
              dynamic_variables: {
                client_name: customParams?.client_name || "",
                client_phone: customParams?.client_phone || "",
                client_email: customParams?.client_email || "",
                client_id: customParams?.client_id || "",
                fecha: customParams?.fecha || "",
                dia_semana: customParams?.dia_semana || "",
              },
            })
          );
        });

        elevenLabsWs.on("message", async (data) => {
          const msg = JSON.parse(data.toString());

          if (msg.type === "user_transcript") {
            const transcript =
              msg.user_transcription_event?.user_transcript
                ?.toLowerCase()
                .trim() ?? "";
            if (transcript && transcript !== lastTranscript) {
              lastTranscript = transcript;

              const voicemail = [
                "buzón de voz",
                "deje su mensaje",
                "no está disponible",
                "después del tono",
                "intente más tarde",
                "gracias por llamar",
              ].some((p) => transcript.includes(p));

              if (voicemail) {
                console.log("[System] Voicemail detected. Ending call...");
                if (elevenLabsWs.readyState === WebSocket.OPEN)
                  elevenLabsWs.close();
                if (ws.readyState === WebSocket.OPEN) ws.close();
              }
            }
          }
        });

        elevenLabsWs.on("close", async () => {
          console.log("[ElevenLabs] Closed");
          if (callSid && customParams?.client_id) {
            const duration = Math.floor(
              (Date.now() - callStartTime.getTime()) / 1000
            );
            await supabase.from("calls").insert({
              user_id: customParams.user_id,
              lead_id: customParams.client_id,
              call_sid: callSid,
              result: "completed",
              transcript: lastTranscript,
              duration,
              created_at: callStartTime.toISOString(),
              ended_at: new Date().toISOString(),
            });
          }
        });

        elevenLabsWs.on("error", (err) =>
          console.error("[ElevenLabs] WS Error:", err)
        );
      };

      setupElevenLabs();

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());

        if (msg.event === "start") {
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          customParams = msg.start.customParameters;
        }

        if (
          msg.event === "media" &&
          elevenLabsWs?.readyState === WebSocket.OPEN
        ) {
          elevenLabsWs.send(
            JSON.stringify({
              type: "user_audio_chunk",
              user_audio_chunk: Buffer.from(
                msg.media.payload,
                "base64"
              ).toString("base64"),
            })
          );
        }

        if (
          msg.event === "stop" &&
          elevenLabsWs?.readyState === WebSocket.OPEN
        ) {
          elevenLabsWs.close();
        }
      });

      ws.on("close", () => {
        if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
      });
    }
  );
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
