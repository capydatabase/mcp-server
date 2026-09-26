// Vercel Function behind https://mcp.capydb.dev/.well-known/oauth-protected-resource[/mcp]
// (see vercel.json): the RFC 9728 document that points MCP clients at the
// control plane's OAuth authorization server.
import { handler } from "../dist/vercel.js";

const serve = (request) => handler.protectedResourceMetadata(request);

export { serve as GET, serve as OPTIONS };
