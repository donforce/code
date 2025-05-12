import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LOG_LEVELS = {
  error: 0,
  warning: 1,
  info: 2,
};

class Logger {
  static shouldLog(level) {
    return LOG_LEVELS[level] <= LOG_LEVELS[LOG_LEVEL];
  }

  static formatMetadata(metadata) {
    try {
      return typeof metadata === "object" ? metadata : { data: metadata };
    } catch (error) {
      return { data: String(metadata) };
    }
  }

  static async log(level, message, options = {}) {
    if (!this.shouldLog(level)) return;

    const {
      userId,
      metadata = {},
      source = process.env.RAILWAY_SERVICE_NAME || "server",
      callSid = null,
      leadId = null,
    } = options;

    const timestamp = new Date().toISOString();
    const formattedMetadata = this.formatMetadata(metadata);

    // Agregar información del entorno
    formattedMetadata.environment = {
      service: process.env.RAILWAY_SERVICE_NAME,
      environment: process.env.RAILWAY_ENVIRONMENT,
      region: process.env.RAILWAY_REGION,
      deployment: process.env.RAILWAY_DEPLOYMENT_ID,
    };

    try {
      const { data, error } = await supabase.from("logs").insert({
        user_id: userId,
        level,
        message,
        metadata: formattedMetadata,
        source,
        call_sid: callSid,
        lead_id: leadId,
        created_at: timestamp,
      });

      if (error) {
        console.error("Error saving log:", error);
        // Fallback a console en caso de error
        this.logToConsole(level, message, formattedMetadata);
      }

      return data;
    } catch (error) {
      console.error("Critical error in logger:", error);
      // Fallback a console en caso de error crítico
      this.logToConsole(level, message, formattedMetadata);
    }
  }

  static logToConsole(level, message, metadata) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    switch (level) {
      case "error":
        console.error(logMessage, metadata);
        break;
      case "warning":
        console.warn(logMessage, metadata);
        break;
      default:
        console.log(logMessage, metadata);
    }
  }

  static info(message, options = {}) {
    return this.log("info", message, options);
  }

  static warning(message, options = {}) {
    return this.log("warning", message, options);
  }

  static error(message, options = {}) {
    return this.log("error", message, options);
  }

  static async getRecentLogs(options = {}) {
    const {
      userId = null,
      level = null,
      limit = 100,
      offset = 0,
      source = null,
      startDate = null,
      endDate = null,
      environment = process.env.RAILWAY_ENVIRONMENT,
    } = options;

    try {
      let query = supabase
        .from("logs")
        .select("*, users(email)")
        .order("created_at", { ascending: false });

      if (userId) query = query.eq("user_id", userId);
      if (level) query = query.eq("level", level);
      if (source) query = query.eq("source", source);
      if (startDate) query = query.gte("created_at", startDate);
      if (endDate) query = query.lte("created_at", endDate);
      if (environment)
        query = query.eq("metadata->environment->environment", environment);

      const { data, error } = await query.range(offset, offset + limit - 1);

      if (error) {
        console.error("Error fetching logs:", error);
        return [];
      }

      return data;
    } catch (error) {
      console.error("Error in getRecentLogs:", error);
      return [];
    }
  }

  // Método para obtener estadísticas de logs
  static async getLogStats(options = {}) {
    const {
      startDate = new Date(Date.now() - 24 * 60 * 60 * 1000), // últimas 24 horas
      endDate = new Date(),
      environment = process.env.RAILWAY_ENVIRONMENT,
    } = options;

    try {
      const { data, error } = await supabase.rpc("get_log_stats", {
        start_date: startDate,
        end_date: endDate,
        env: environment,
      });

      if (error) {
        console.error("Error fetching log stats:", error);
        return null;
      }

      return data;
    } catch (error) {
      console.error("Error in getLogStats:", error);
      return null;
    }
  }
}

export default Logger;
