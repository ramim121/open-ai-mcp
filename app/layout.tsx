export const metadata = {
  title: "openai-image-remote-mcp",
  description: "Remote MCP server for OpenAI image generation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
