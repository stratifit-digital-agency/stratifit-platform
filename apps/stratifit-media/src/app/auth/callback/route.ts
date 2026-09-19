import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Auth callback (Stage 2.14 D2.14-3): exchanges the Supabase Auth code for a
 * session and persists the refresh cookies server-side via @supabase/ssr,
 * then redirects back into the public app. Session cookies remain
 * server-managed; the browser never receives server secrets. Excluded from
 * the middleware matcher. This is session plumbing — NOT a signup flow.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const redirectResponse = NextResponse.redirect(`${origin}${next}`);

  if (code) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.redirect(`${origin}/login?error=not_configured`);
    }
    const client = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value, options } of list) {
            redirectResponse.cookies.set(name, value, options);
          }
        },
      },
    });
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(`${origin}/login?error=exchange_failed`);
  }

  return redirectResponse;
}
