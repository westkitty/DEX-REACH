import { createMcpExpressApp } from '@modelcontextprotocol/express';

export function gatewayAllowedHostnames(publicBaseUrl: URL): string[] {
  const publicHostname = publicBaseUrl.hostname.toLowerCase();
  return [...new Set([publicHostname, 'localhost', '127.0.0.1', '[::1]'])];
}

export function createGatewayExpressApp(host: string, publicBaseUrl: URL) {
  const allowedHostnames = gatewayAllowedHostnames(publicBaseUrl);
  // The gateway binds locally behind the public HTTPS ingress. Host and Origin are separate
  // DNS-rebinding/CSRF checks in the MCP SDK, so the configured public hostname must be admitted
  // to both. Keeping one exact allowlist prevents the two protections from drifting apart.
  return createMcpExpressApp({
    host,
    allowedHosts: allowedHostnames,
    allowedOrigins: allowedHostnames
  });
}
