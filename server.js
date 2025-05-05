import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_KEY
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

fastify.post("/outbound-call", async (request, reply) => {
  const {
    number,
    prompt,
    first_message,
    client_name,
    client_phone,
    client_email,
    client_id,
  } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  const date = new Date();
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
  const fecha = `${String(date.getDate()).padStart(2, "0")}/${String(
    date.getMonth() + 1
  ).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
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

    await supabase.from("calls").insert({
      call_sid: call.sid,
      lead_id: client_id,
      user_phone: client_phone,
      user_email: client_email,
      result: "initiated",
      started_at: new Date().toISOString(),
    });

    reply.send({ success: true, message: "Call initiated", callSid: call.sid });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({ success: false, error: "Failed to initiate call" });
  }
});

fastify.all("/outbound-call-twiml", async (request, reply) => {
  const params = request.query;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/outbound-media-stream">
          ${Object.entries(params)
            .map(([key, val]) => `<Parameter name="${key}" value="${val}" />`)
            .join("\n")}
        </Stream>
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let startTime = null;

      ws.on("error", console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");
            startTime = new Date();

            elevenLabsWs.send(
              JSON.stringify({
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                  agent: { agent_id: ELEVENLABS_AGENT_ID },
                  keep_alive: true,
                },
                dynamic_variables: customParameters || {},
                usage: { no_ip_reason: "user_ip_not_collected" },
              })
            );

            elevenLabsWs.send(
              JSON.stringify({
                type: "audio",
                audio_event: {
                  audio_base_64: Buffer.from([0x00]).toString("base64"),
                },
              })
            );
          });

          elevenLabsWs.on("message", async (data) => {
            const message = JSON.parse(data);
            if (message.type === "user_transcript") {
              const transcript =
                message.user_transcription_event?.user_transcript
                  ?.toLowerCase()
                  .trim() || "";
              const isMachine =
                /mensaje de voz|buz[oó]n|no est[aá] disponible|intente m[aá]s tarde/.test(
                  transcript
                );
              if (isMachine && callSid) {
                await endCall("machine");
                return;
              }
            }
          });

          elevenLabsWs.on("close", async () => {
            console.log("[ElevenLabs] Disconnected");
            await endCall("completed");
          });

          elevenLabsWs.on("error", (err) =>
            console.error("[ElevenLabs] WebSocket error:", err)
          );
        } catch (err) {
          console.error("[ElevenLabs] Setup error:", err);
        }
      };

      const endCall = async (status) => {
        const endTime = new Date();
        const duration = Math.round(
          (endTime.getTime() - startTime.getTime()) / 1000
        );
        if (callSid && customParameters?.client_id) {
          await supabase
            .from("calls")
            .update({
              result: status,
              ended_at: endTime.toISOString(),
              duration_seconds: duration,
            })
            .eq("call_sid", callSid);
        }
      };

      setupElevenLabs();

      ws.on("message", (msg) => {
        const parsed = JSON.parse(msg);
        if (parsed.event === "start") {
          streamSid = parsed.start.streamSid;
          callSid = parsed.start.callSid;
          customParameters = parsed.start.customParameters;
        } else if (
          parsed.event === "media" &&
          elevenLabsWs?.readyState === WebSocket.OPEN
        ) {
          elevenLabsWs.send(
            JSON.stringify({
              type: "user_audio_chunk",
              user_audio_chunk: Buffer.from(
                parsed.media.payload,
                "base64"
              ).toString("base64"),
            })
          );
        } else if (parsed.event === "stop") {
          if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
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

async function getSignedUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    }
  );
  const data = await res.json();
  return data.signed_url;
}
