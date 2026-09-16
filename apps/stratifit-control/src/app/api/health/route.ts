import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    app: "stratifit-control",
    status: "ok",
    time: new Date().toISOString(),
  });
}
