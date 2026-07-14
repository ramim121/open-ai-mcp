export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", lineHeight: 1.5 }}>
      <h1>openai-image-remote-mcp</h1>
      <p>
        This is a remote MCP server. The MCP endpoint is <code>/api/mcp</code> and requires the
        shared secret (<code>?k=...</code>). There is nothing to see here.
      </p>
    </main>
  );
}
