import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function getSignedUrl() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.statusText}`);
  }
  const data = await response.json();
  return data.signed_url;
}

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

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({ success: false, error: "Failed to initiate call" });
  }
});

fastify.all("/outbound-call-twiml", async (request, reply) => {
  const {
    prompt,
    first_message,
    client_name,
    client_phone,
    client_email,
    client_id,
    fecha,
    dia_semana,
  } = request.query;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/outbound-media-stream">
          <Parameter name="prompt" value="${prompt}" />
          <Parameter name="first_message" value="${first_message}" />
          <Parameter name="client_name" value="${client_name}" />
          <Parameter name="client_phone" value="${client_phone}" />
          <Parameter name="client_email" value="${client_email}" />
          <Parameter name="client_id" value="${client_id}" />
          <Parameter name="fecha" value="${fecha}" />
          <Parameter name="dia_semana" value="${dia_semana}" />
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
      let lastUserTranscript = "";

      ws.on("error", console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  agent_id: ELEVENLABS_AGENT_ID,
                },
                keep_alive: true,
              },
              dynamic_variables: {
                client_name: customParameters?.client_name || "Cliente",
                client_phone: customParameters?.client_phone || "",
                client_email: customParameters?.client_email || "",
                client_id: customParameters?.client_id || "",
                fecha: customParameters?.fecha || "",
                dia_semana: customParameters?.dia_semana || "",
              },
              usage: {
                no_ip_reason: "user_ip_not_collected",
              },
            };

            console.log("initialConfig ", JSON.stringify(initialConfig));
            elevenLabsWs.send(JSON.stringify(initialConfig));

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
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log(
                    "[ElevenLabs] Received initiation metadata",
                    JSON.stringify(message, null, 2)
                  );
                  break;

                case "audio":
                  if (streamSid) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload:
                          message.audio?.chunk ||
                          message.audio_event?.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  const transcript =
                    message.user_transcription_event?.user_transcript
                      ?.toLowerCase()
                      .trim() || "";

                  console.log(`[Twilio] User transcript: ${transcript}`);

                  if (transcript === lastUserTranscript) {
                    console.log(
                      "[System] Repeated transcript detected, ignoring..."
                    );
                    break;
                  }

                  lastUserTranscript = transcript;

                  const normalized = transcript.replace(/[\s,]/g, "");
                  const isNumericSequence = /^\d{7,}$/.test(normalized);
                  const hasVoicemailPhrases = [
                    "deje su mensaje",
                    "después del tono",
                    "mensaje de voz",
                    "buzón de voz",
                    "el número que usted marcó",
                    "no está disponible",
                    "intente más tarde",
                    "ha sido desconectado",
                    "gracias por llamar",
                  ].some((phrase) => transcript.includes(phrase));

                  if (isNumericSequence || hasVoicemailPhrases) {
                    console.log(
                      "[System] Detected voicemail or machine response. Hanging up..."
                    );

                    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                      elevenLabsWs.close();
                    }

                    if (callSid) {
                      try {
                        await twilioClient
                          .calls(callSid)
                          .update({ status: "completed" });
                        console.log(
                          `[Twilio] Call ${callSid} terminated due to invalid transcript.`
                        );
                      } catch (err) {
                        console.error(
                          "[Twilio] Error ending call after detection:",
                          err
                        );
                      }
                    }

                    if (ws.readyState === WebSocket.OPEN) {
                      ws.close();
                    }

                    break;
                  }

                  break;

                default:
                  if (message.type !== "ping") {
                    console.log(
                      `[ElevenLabs] Unhandled message type: ${message.type}`
                    );
                  }
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", async () => {
            console.log("[ElevenLabs] Disconnected");

            if (callSid) {
              try {
                await twilioClient
                  .calls(callSid)
                  .update({ status: "completed" });
                console.log(
                  `[Twilio] Call ${callSid} ended due to ElevenLabs disconnection.`
                );
              } catch (err) {
                console.error("[Twilio] Error ending call:", err);
              }
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
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
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
