import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { AuthError, redact, toUserMessage } from './errors.js';

/** Progress notifications for a tool call (no-op when the client sent no progressToken). */
export function progressFor(ctx: ServerContext): (p: number, total: number | undefined, message: string) => void {
  const token = (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
  if (token === undefined) return () => {};
  let last = -1;
  return (progress, total, message) => {
    if (progress <= last) progress = last + 0.01; // progress MUST increase
    last = progress;
    void ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } })
      .catch(() => {});
  };
}

/** Replaces any configured secret value that might appear in a message. */
export function redactValues(text: string, values: Iterable<string> = []): string {
  let out = redact(text);
  for (const v of values) if (v && v.length >= 6) out = out.split(v).join('***');
  return out;
}

export function errorResult(err: unknown, log?: (m: string) => void, secrets: Iterable<string> = []): CallToolResult {
  const list = [...secrets];
  const msg = redactValues(toUserMessage(err), list);
  if (log && !(err instanceof AuthError) && msg.startsWith('Internal error')) log(`tool error: ${redactValues(String((err as Error)?.stack ?? err), list)}`);
  return { isError: true, content: [{ type: 'text', text: msg }] };
}
