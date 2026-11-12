// `-` is admitted in path segments: the builder names nodes `agent-1`, `script-1`.
function get(ctx: unknown, path: string): unknown { return path.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'&&!Array.isArray(v)?(v as Record<string,unknown>)[k]:undefined,ctx); }
export function interpolateTemplate(template: string, context: unknown): string { return template.replace(/{{\s*([a-zA-Z][\w.-]*)\s*}}/g, (_m,path) => { const v=get(context,path); return v === undefined ? '' : typeof v==='string' ? v : JSON.stringify(v); }); }
export { get as contextValue };
