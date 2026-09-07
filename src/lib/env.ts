import { z } from "zod";

const serverSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(10),
  SUPABASE_SECRET_KEY: z.string().min(10).optional(),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_FROM: z.string().min(1).optional(),
  CRON_SECRET: z.string().min(32).optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;

export function hasSupabaseConfig() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function getPublicSupabaseEnv() {
  const parsed = serverSchema
    .pick({
      NEXT_PUBLIC_SUPABASE_URL: true,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: true,
    })
    .safeParse({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    });
  if (!parsed.success) {
    throw new Error("Supabase public environment variables are not configured.");
  }
  return parsed.data;
}

// The environment cannot change within an isolate's lifetime, so validate once
// and reuse. This is called per request by the cron route and on every R2
// signing operation.
let serverEnv: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (serverEnv) return serverEnv;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid server environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  serverEnv = parsed.data;
  return serverEnv;
}
