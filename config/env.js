import 'dotenv/config'
import { z } from 'zod'

/**
 * Fail fast on bad configuration. A server that boots with a missing
 * DATABASE_URL only fails later, on the first request, somewhere confusing.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  DATABASE_URL: z.string().min(1),

  // ---- Cloudinary ----
  // Optional at boot so the server runs before the keys are filled in;
  // lib/cloudinary.js reports a clear error if a media route is called
  // without them.
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_FOLDER: z.string().default('equalmind'),
  // Enables genuinely time-limited delivery URLs. Cloudinary calls this
  // "token-based authentication" and it is a paid add-on; without the key,
  // delivery URLs are signed but do not expire. Settings -> Security.
  CLOUDINARY_AUTH_TOKEN_KEY: z.string().default(''),
  // Largest image accepted, in bytes. Multer rejects anything above it before
  // a single byte reaches Cloudinary.
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid server environment:')
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  console.error('\nCopy .env.example to .env and fill in the values.')
  process.exit(1)
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  // CLIENT_ORIGIN accepts a comma-separated list.
  clientOrigins: parsed.data.CLIENT_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
}
