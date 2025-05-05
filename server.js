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
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

fastify.post("/save-call-result", async (request, reply) => {
  const { lead_id, user_id, call_sid, result, duration } = request.body;

  try {
    const { error } = await supabase.from("calls").insert({
      lead_id,
      user_id,
      call_sid,
      result,
      duration,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error("Error saving call result:", error.message);
      return reply.code(500).send({ success: false, error: error.message });
    }

    reply.send({ success: true });
  } catch (err) {
    console.error("Unexpected error saving call result:", err);
    reply.code(500).send({ success: false, error: "Unexpected server error" });
  }
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
      let lastUserTranscript = "";
      let callStartTime = Date.now();

      ws.on("error", console.error);

      const saveCallToSupabase = async (result) => {
        const duration = Math.floor((Date.now() - callStartTime) / 1000);

        if (!customParameters) return;

        await supabase.from("calls").insert({
          lead_id: customParameters.client_id,
          user_id: customParameters.user_id || null,
          call_sid: callSid,
          result,
          duration,
          created_at: new Date().toISOString(),
        });
      };

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
            {
              method: "GET",
              headers: { "xi-api-key": ELEVENLABS_API_KEY },
            }
          ).then((res) => res.json());

          elevenLabsWs = new WebSocket(signedUrl.signed_url);

          elevenLabsWs.on("open", () => {
            elevenLabsWs.send(
              JSON.stringify({
                type: "conversation_initiation_client_data",
                conversation_config_override: {
                  agent: { agent_id: ELEVENLABS_AGENT_ID },
                  keep_alive: true,
                },
                dynamic_variables: customParameters,
                usage: { no_ip_reason: "user_ip_not_collected" },
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

              if (transcript === lastUserTranscript) return;
              lastUserTranscript = transcript;

              const normalized = transcript.replace(/\s|,/g, "");
              const isVoicemail =
                /^\d{7,}$/.test(normalized) ||
                [
                  "deje su mensaje",
                  "después del tono",
                  "mensaje de voz",
                  "buzón de voz",
                  "el número que usted marcó",
                  "no está disponible",
                  "intente más tarde",
                  "ha sido desconectado",
                  "gracias por llamar",
                ].some((p) => transcript.includes(p));

              if (isVoicemail) {
                await saveCallToSupabase("voicemail");
                elevenLabsWs.close();
                ws.close();
                return;
              }
            }
          });

          elevenLabsWs.on("close", async () => {
            await saveCallToSupabase("completed");
            ws.close();
          });
        } catch (err) {
          console.error("[ElevenLabs] Setup error:", err);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        const msg = JSON.parse(message);
        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters;
            break;
          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
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
            break;
          case "stop":
            elevenLabsWs?.close();
            break;
        }
      });

      ws.on("close", () => {
        elevenLabsWs?.close();
      });
    }
  );
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
