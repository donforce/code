// Server configuration and setup
import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import { createClient } from "@supabase/supabase-js";
import os from "os";
import { performance } from "perf_hooks";

dotenv.config();

// Add comprehensive startup logging
console.log("🚀 [STARTUP] Starting Clear CRM API Server...");
console.log("📅 [STARTUP] Timestamp:", new Date().toISOString());
console.log("🔧 [STARTUP] Node.js version:", process.version);
console.log("🌍 [STARTUP] Environment:", process.env.NODE_ENV || "development");

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  RAILWAY_PUBLIC_DOMAIN,
} = process.env;

// Log environment variables status (without exposing sensitive data)
console.log("🔑 [STARTUP] Environment variables check:");
console.log(
  "  - ELEVENLABS_API_KEY:",
  ELEVENLABS_API_KEY ? "✅ Set" : "❌ Missing"
);
console.log(
  "  - ELEVENLABS_AGENT_ID:",
  ELEVENLABS_AGENT_ID ? "✅ Set" : "❌ Missing"
);
console.log(
  "  - TWILIO_ACCOUNT_SID:",
  TWILIO_ACCOUNT_SID ? "✅ Set" : "❌ Missing"
);
console.log(
  "  - TWILIO_AUTH_TOKEN:",
  TWILIO_AUTH_TOKEN ? "✅ Set" : "❌ Missing"
);
console.log(
  "  - TWILIO_PHONE_NUMBER:",
  TWILIO_PHONE_NUMBER ? "✅ Set" : "❌ Missing"
);
console.log("  - SUPABASE_URL:", SUPABASE_URL ? "✅ Set" : "❌ Missing");
console.log(
  "  - SUPABASE_SERVICE_ROLE_KEY:",
  SUPABASE_SERVICE_ROLE_KEY ? "✅ Set" : "❌ Missing"
);
console.log(
  "  - RAILWAY_PUBLIC_DOMAIN:",
  RAILWAY_PUBLIC_DOMAIN ? "✅ Set" : "❌ Missing"
);

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !RAILWAY_PUBLIC_DOMAIN
) {
  console.error("❌ [STARTUP] Missing required environment variables");
  throw new Error("Missing required environment variables");
}

console.log("✅ [STARTUP] All required environment variables are set");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
console.log("🔗 [STARTUP] Supabase client initialized");

const fastify = Fastify();
console.log("⚡ [STARTUP] Fastify instance created");

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
console.log("🔌 [STARTUP] Fastify plugins registered");

const PORT = process.env.PORT || 8000;
console.log("🌐 [STARTUP] Server will listen on port:", PORT);

const activeUserCalls = new Map(); // Track active calls per user
console.log("📊 [STARTUP] Active user calls tracking initialized");

// Add metrics tracking variables
let startTime = performance.now();
let totalCalls = 0;
let activeCalls = 0;
let failedCalls = 0;
let lastMetricsCheck = Date.now();
console.log("📈 [STARTUP] Metrics tracking initialized");

// ... existing code ...

fastify.post("/api/integration/leads", async (request, reply) => {
  console.log(
    "🔍 [API] POST /api/integration/leads called at",
    new Date().toISOString()
  );
  console.log(
    "🔍 [API] Request headers:",
    JSON.stringify(request.headers, null, 2)
  );
  console.log("🔍 [API] Request body:", JSON.stringify(request.body, null, 2));

  try {
    const apiKey =
      request.headers["x-api-key"] ||
      request.headers["authorization"]?.replace("Bearer ", "");

    console.log("🔑 [API] API Key extracted:", apiKey ? "Present" : "Missing");

    if (!apiKey) {
      console.warn("❌ [API] No API key provided");
      return reply.code(401).send({ error: "API key requerida" });
    }

    console.log("🔍 [API] Validating API key...");
    const { data: keyData, error: keyError } = await supabase
      .from("api_keys")
      .select("user_id, is_active")
      .eq("api_key", apiKey)
      .single();

    console.log("🔍 [API] API key validation result:", { keyError, keyData });

    if (keyError || !keyData || !keyData.is_active) {
      console.warn("❌ [API] Invalid API key", { keyError, keyData });
      return reply.code(401).send({ error: "API key inválida" });
    }

    const userId = keyData.user_id;
    console.log("✅ [API] API key valid for user:", userId);

    const body = request.body;
    console.log(
      "📝 [API] Processing lead data:",
      JSON.stringify(body, null, 2)
    );

    const {
      name,
      phone,
      email,
      auto_call = false,
      source = "api",
      notes,
    } = body;

    console.log("🔍 [API] Extracted fields:", {
      name,
      phone,
      email,
      auto_call,
      source,
      notes,
    });

    if (!name || !phone || !email) {
      console.warn("❌ [API] Missing required fields", { name, phone, email });
      return reply.code(400).send({ error: "Campos requeridos faltantes" });
    }

    console.log("💾 [API] Inserting lead into database...");
    const { data: newLead, error: insertError } = await supabase
      .from("leads")
      .insert({
        user_id: userId,
        name,
        phone,
        email,
        auto_call,
        source,
        notes,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error("❌ [API] Error inserting lead:", insertError);
      return reply.code(400).send({ error: insertError.message });
    }

    console.log(
      "✅ [API] Lead created successfully:",
      JSON.stringify(newLead, null, 2)
    );

    // Check if auto_call is enabled and add to queue
    if (auto_call) {
      console.log("📞 [API] Auto_call enabled, adding to call queue...");
      try {
        // Get the last queue position
        const { data: existingQueue } = await supabase
          .from("call_queue")
          .select("queue_position")
          .order("queue_position", { ascending: false })
          .limit(1);

        const nextPosition =
          existingQueue && existingQueue.length > 0
            ? (existingQueue[0]?.queue_position || 0) + 1
            : 1;

        console.log("📊 [API] Next queue position:", nextPosition);

        const { error: queueError } = await supabase.from("call_queue").insert({
          user_id: userId,
          lead_id: newLead.id,
          queue_position: nextPosition,
          status: "pending",
          created_at: new Date().toISOString(),
        });

        if (queueError) {
          console.error("❌ [API] Error adding to call queue:", queueError);
        } else {
          console.log("✅ [API] Lead added to call queue successfully");
        }
      } catch (queueError) {
        console.error(
          "❌ [API] Error in auto_call queue processing:",
          queueError
        );
      }
    } else {
      console.log("📞 [API] Auto_call disabled, lead not added to queue");
    }

    console.log("🎉 [API] Request completed successfully");
    return reply.send({ success: true, data: newLead });
  } catch (error) {
    console.error("💥 [API] Error en API de leads:", error);
    return reply.code(500).send({ error: "Error interno del servidor" });
  }
});
