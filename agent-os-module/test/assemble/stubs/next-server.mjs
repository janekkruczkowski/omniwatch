// Stub for next/server so /api/video/auto/assemble can run outside Next.
// NextResponse.json is the only thing the route uses from it.
export class NextResponse extends Response {
  static json(body, init) {
    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json" },
    });
  }
}
