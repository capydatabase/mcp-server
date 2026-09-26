// Vercel Function behind https://mcp.capydb.dev/mcp (see vercel.json). The
// handler is built by `pnpm build` from src/vercel.ts.
import { handler } from "../dist/vercel.js";

const serve = (request) => handler.mcp(request);

export { serve as GET, serve as POST, serve as DELETE, serve as OPTIONS };
