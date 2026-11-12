import { McpClient } from './mcp-client';

export const dynamic = 'force-dynamic';

export default function McpPage() {
  return (
    <div className="relative z-[1] h-full overflow-auto px-7 pt-5 pb-8">
      <h1 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        MCP servers
      </h1>
      <div className="mt-1 flex flex-wrap items-baseline gap-3.5">
        <div className="text-[22px] font-semibold -tracking-[0.01em]">
          Model Context Protocol servers — local stdio processes and remote HTTP
          endpoints you can attach to agents.
        </div>
      </div>
      <McpClient />
    </div>
  );
}
