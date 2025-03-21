import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
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

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
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
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message, client_name } = request.body;
  console.error("/outbound-call", request.body);

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

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
      )}&client_name=${encodeURIComponent(client_name)}`,
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

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "Eres un asistente especialista en el sector inmobiliario";
  const first_message = request.query.first_message || "Hola como estas?";
  const client_name = request.query.client_name || "Cliente";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
            <Parameter name="client_name" value="${client_name}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

fastify.all("/get-personal", async (request, reply) => {
  console.log(" request ",request.body);
  const {caller_id}=request.body;

  reply.send({
    dynamic_variables: {
      client_name: "Cliente",
    },
    conversation_config_override: {
      agent: {
        prompt: {
          prompt: "Hola {client_name}, soy un asistente de bienes raíces en Florida. ¿Cómo puedo ayudarte hoy?",
        },
        first_message: "Hola {client_name}, estoy aquí para ayudarte con tu consulta sobre propiedades.",
      },
      keep_alive: true,
    },
  });
});

// WebSocket route for handling media streams
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

      ws.on("error", console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const clientName =
              customParameters?.client_name?.trim() || "Cliente";

            const silencePacket = {
              type: "audio",
              audio_event: {
                audio_base_64: Buffer.from([0x00]).toString("base64"),
              },
            };

            elevenLabsWs.send(JSON.stringify(silencePacket));

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  agent_id: ELEVENLABS_AGENT_ID,
                  prompt: {
                    prompt: "Hola {client_name}, soy un asistente de bienes raíces en Florida. ¿Cómo puedo ayudarte hoy?",
                  },
                  first_message: "Hola {client_name}, estoy aquí para ayudarte con tu consulta sobre propiedades.",
                },
                keep_alive: true,
              },
              dynamic_variables: {
                client_name: customParameters?.client_name || "Cliente",
              },
            };
            
            console.log("initialConfig ",JSON.stringify(initialConfig));


            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata", JSON.stringify(message, null, 2));
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
                  console.log(
                    `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
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
