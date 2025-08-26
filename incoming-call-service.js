import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { ELEVENLABS_API_KEY, RAILWAY_PUBLIC_DOMAIN } = process.env;

const fastify = Fastify({
  logger: false,
  connectionTimeout: 30000,
  keepAliveTimeout: 30000,
  maxRequestsPerSocket: 100,
  disableRequestLogging: true,
  bodyLimit: 1048576,
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Twilio incoming call endpoint for AI assistant
fastify.all("/twilio/incoming-call", async (request, reply) => {
  try {
    const toNumber = request.body?.To;
    const fromNumber = request.body?.From;
    const callSid = request.body?.CallSid;

    console.log("📞 [TWILIO INCOMING] Incoming call details:", {
      toNumber,
      fromNumber,
      callSid,
    });

    // Retornar TwiML para conectar directamente con ElevenLabs Agent
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${RAILWAY_PUBLIC_DOMAIN}/incoming-media-stream" interruptible="true">
      <Parameter name="agent_id" value="agent_9001k3m4b0y4fhyvwc9car16yqw2"/>
      <Parameter name="callSid" value="${callSid || "unknown"}"/>
      <Parameter name="fromNumber" value="${fromNumber || "unknown"}"/>
      <Parameter name="toNumber" value="${toNumber || "unknown"}"/>
    </Stream>
  </Connect>
</Response>`;

    console.log("✅ [TWILIO INCOMING] Connecting to ElevenLabs Agent:", {
      agent_id: "agent_9001k3m4b0y4fhyvwc9car16yqw2",
      toNumber,
      fromNumber,
      callSid,
    });

    reply.type("text/xml").send(twiml);
  } catch (error) {
    console.error(
      "❌ [TWILIO INCOMING] Error processing incoming call:",
      error
    );
    reply.code(500).send({ error: "Internal server error" });
  }
});

// WebSocket endpoint registration
fastify.register(async (fastifyInstance) => {
  // Add incoming media stream endpoint
  fastifyInstance.get(
    "/incoming-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to incoming media stream");

      let streamSid = null;
      let callSid = null;
      let agentId = null;
      let elevenLabsWs = null;

      ws.on("error", console.error);

      // Handle WebSocket messages
      ws.on("message", async (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.event === "start") {
            streamSid = message.start.streamSid;
            callSid = message.start.callSid;
            agentId =
              message.start.customParameters?.agent_id ||
              "agent_9001k3m4b0y4fhyvwc9car16yqw2";

            console.log("📞 [INCOMING] Stream started:", {
              streamSid,
              callSid,
              agentId,
            });

            // Connect to ElevenLabs Agent
            try {
              const response = await fetch(
                `https://api.elevenlabs.io/v1/agents/${agentId}/stream`,
                {
                  method: "POST",
                  headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    input_audio_format: "mulaw",
                    output_audio_format: "mulaw",
                    sample_rate: 8000,
                    enable_interruptions: true,
                  }),
                }
              );

              if (response.ok) {
                elevenLabsWs = new WebSocket(response.url);

                elevenLabsWs.on("open", () => {
                  console.log("✅ [ELEVENLABS] Connected to agent stream");
                });

                elevenLabsWs.on("message", (data) => {
                  // Forward ElevenLabs audio to Twilio
                  ws.send(
                    JSON.stringify({
                      event: "media",
                      streamSid: streamSid,
                      media: {
                        payload: data.toString("base64"),
                      },
                    })
                  );
                });

                elevenLabsWs.on("error", (error) => {
                  console.error("❌ [ELEVENLABS] WebSocket error:", error);
                });

                elevenLabsWs.on("close", () => {
                  console.log("📞 [ELEVENLABS] WebSocket connection closed");
                });
              } else {
                console.error(
                  "❌ [ELEVENLABS] Failed to connect to agent:",
                  response.status
                );
              }
            } catch (error) {
              console.error(
                "❌ [ELEVENLABS] Error connecting to agent:",
                error
              );
            }
          } else if (message.event === "media") {
            // Forward Twilio audio to ElevenLabs
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              const audioData = Buffer.from(message.media.payload, "base64");
              elevenLabsWs.send(audioData);
            }
          } else if (message.event === "stop") {
            console.log("📞 [INCOMING] Stream stopped");
            if (elevenLabsWs) {
              elevenLabsWs.close();
            }
          }
        } catch (error) {
          console.error("❌ [INCOMING] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("📞 [INCOMING] WebSocket connection closed");
        if (elevenLabsWs) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// Start the server
const start = async () => {
  try {
    console.log("🚀 Incoming Call Service starting on port", PORT);
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log("✅ Incoming Call Service running");
  } catch (err) {
    console.error("❌ Error starting Incoming Call Service:", err);
    process.exit(1);
  }
};

// Iniciar el servidor
if (!fastify.server.listening) {
  start();
}
