// Server configuration and setup
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
const activeUserCalls = new Map(); // Track active calls per user

// Subscribe to call queue changes
const queueChannel = supabase
  .channel("server-queue")
  .on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "call_queue",
    },
    async (payload) => {
      try {
        if (
          payload.eventType === "INSERT" &&
          payload.new.status === "pending"
        ) {
          await processUserQueue(payload.new.user_id);
        }
      } catch (error) {
        console.error("Error processing queue event:", error);
      }
    }
  )
  .subscribe();

// Process all pending queues
async function processAllPendingQueues() {
  try {
    console.log("[Queue] Starting to process all pending queues");

    // Obtener usuarios únicos con llamadas pendientes
    const { data: pendingQueues, error } = await supabase
      .from("call_queue")
      .select("user_id, id")
      .eq("status", "pending")
      .order("queue_position", { ascending: true });

    if (error) {
      console.error("[Queue] Error fetching pending queues:", error);
      throw error;
    }

    console.log("[Queue] Found pending queues:", pendingQueues?.length || 0);

    // Procesar cola para cada usuario
    const uniqueUserIds = [
      ...new Set(pendingQueues?.map((q) => q.user_id) || []),
    ];
    console.log("[Queue] Unique users to process:", uniqueUserIds.length);

    for (const userId of uniqueUserIds) {
      await processUserQueue(userId);
    }
  } catch (error) {
    console.error("[Queue] Error processing pending queues:", error);
  }
}

// Process queues every 30 seconds
const QUEUE_INTERVAL = 30000; // Fijando a 30 segundos
console.log("[Queue] Setting up queue processing interval:", QUEUE_INTERVAL);

const queueInterval = setInterval(processAllPendingQueues, QUEUE_INTERVAL);
// Asegurarnos de que el intervalo se limpia si la aplicación se detiene
process.on("SIGTERM", () => clearInterval(queueInterval));
process.on("SIGINT", () => clearInterval(queueInterval));

// Process queues on startup
console.log("[Queue] Processing queues on startup");
processAllPendingQueues();

async function processUserQueue(userId) {
  try {
    console.log("[Queue] Processing user queue", { userId });

    // Check if user already has an active call
    if (activeUserCalls.get(userId)) {
      console.log("[Queue] User has active call, skipping", { userId });
      return;
    }

    // Get next pending call for this user
    const { data: nextCall, error: queueError } = await supabase
      .from("call_queue")
      .select(
        `
        *,
        lead:leads (
          name,
          phone,
          email
        )
      `
      )
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("queue_position", { ascending: true })
      .limit(1)
      .single();

    if (queueError) {
      if (queueError.code === "PGRST116") {
        console.log("[Queue] No pending calls for user", { userId });
        return;
      }
      console.error("[Queue] Error fetching next call:", queueError);
      throw queueError;
    }

    if (nextCall) {
      console.log("[Queue] Processing next call in queue", {
        userId,
        queueId: nextCall.id,
        leadId: nextCall.lead_id,
      });

      // Update status to in_progress
      const { error: updateError } = await supabase
        .from("call_queue")
        .update({
          status: "in_progress",
          started_at: new Date().toISOString(),
        })
        .eq("id", nextCall.id);

      if (updateError) {
        console.error("[Queue] Error updating queue status:", updateError);
        throw updateError;
      }

      console.log("[Queue] Updated queue item status to in_progress", {
        queueId: nextCall.id,
      });

      // Process the call
      const success = await processQueueItem(nextCall);

      if (!success) {
        console.error("[Queue] Failed to process call", {
          userId,
          queueId: nextCall.id,
        });

        // Mark as failed
        const { error: failedError } = await supabase
          .from("call_queue")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: "Error processing the call",
          })
          .eq("id", nextCall.id);

        if (failedError) {
          console.error("[Queue] Error updating failed status:", failedError);
        }
      }
    }
  } catch (error) {
    console.error("[Queue] Error processing user queue:", error);
    // Release user in case of error
    activeUserCalls.delete(userId);
  }
}

async function processQueueItem(queueItem) {
  try {
    // Mark user as having active call
    activeUserCalls.set(queueItem.user_id, true);

    console.log("[Queue] Initiating call", {
      userId: queueItem.user_id,
      leadId: queueItem.lead_id,
      queueId: queueItem.id,
    });

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

    // Make the call
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: queueItem.lead.phone,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        "Eres un asistente de ventas inmobiliarias."
      )}&first_message=${encodeURIComponent(
        "Hola, ¿cómo estás?"
      )}&client_name=${encodeURIComponent(
        queueItem.lead.name
      )}&client_phone=${encodeURIComponent(
        queueItem.lead.phone
      )}&client_email=${encodeURIComponent(
        queueItem.lead.email
      )}&client_id=${encodeURIComponent(
        queueItem.lead_id
      )}&fecha=${encodeURIComponent(fecha)}&dia_semana=${encodeURIComponent(
        dia_semana
      )}`,
      statusCallback: `https://${request.headers.host}/twilio-status`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });

    console.log("[Queue] Call initiated successfully", {
      callSid: call.sid,
      queueId: queueItem.id,
    });

    // Register the call
    const { error: callError } = await supabase.from("calls").insert({
      lead_id: queueItem.lead_id,
      user_id: queueItem.user_id,
      call_sid: call.sid,
      status: "In Progress",
      result: "initiated",
      queue_id: queueItem.id, // Agregando referencia a la cola
    });

    if (callError) {
      console.error("[Queue] Error registering call:", callError);
      throw callError;
    }

    return true;
  } catch (error) {
    console.error("[Queue] Error processing call:", error);
    // Release user in case of error
    activeUserCalls.delete(queueItem.user_id);
    return false;
  }
}

// Rest of your existing code...
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

// Your existing outbound-call endpoint
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
      statusCallback: `https://${request.headers.host}/twilio-status`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({ success: false, error: "Failed to initiate call" });
  }
});

// Your existing outbound-call-twiml endpoint
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

// Your existing WebSocket endpoint registration
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

// Your existing twilio-status endpoint with queue management
fastify.post("/twilio-status", async (request, reply) => {
  const callSid = request.body.CallSid;
  const callDuration = parseInt(request.body.CallDuration || "0", 10);
  const callStatus = request.body.CallStatus;
  console.log("[Twilio] Status update received", {
    callSid,
    callStatus,
    callDuration,
  });

  try {
    // Update call status
    const { data: call, error: callError } = await supabase
      .from("calls")
      .update({
        duration: callDuration,
        status: callStatus,
      })
      .eq("call_sid", callSid)
      .select("user_id, queue_id")
      .single();

    if (callError) {
      console.error("[Twilio] Error updating call:", callError);
      throw callError;
    }

    console.log("[Twilio] Call updated successfully", { call });

    if (call?.user_id) {
      // Release the user's active call status
      activeUserCalls.delete(call.user_id);

      // Update queue item status if exists
      if (call.queue_id) {
        const { error: queueError } = await supabase
          .from("call_queue")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
          })
          .eq("id", call.queue_id);

        if (queueError) {
          console.error("[Twilio] Error updating queue item:", queueError);
        } else {
          console.log("[Twilio] Queue item marked as completed", {
            queueId: call.queue_id,
          });
        }
      }

      // Process next queue item for this user
      await processUserQueue(call.user_id);
    }

    reply.code(200).send("OK");
  } catch (error) {
    console.error("[Twilio] Error in status callback:", error);
    reply.code(500).send("Error");
  }
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
