import { proxyPluginRequest, type PluginRouteParams } from '@/lib/ui/plugin-proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Params = { params: PluginRouteParams };
export async function GET(request: Request, { params }: Params): Promise<Response> { return proxyPluginRequest('GET', request, params); }
export async function POST(request: Request, { params }: Params): Promise<Response> { return proxyPluginRequest('POST', request, params); }
export async function PUT(request: Request, { params }: Params): Promise<Response> { return proxyPluginRequest('PUT', request, params); }
export async function PATCH(request: Request, { params }: Params): Promise<Response> { return proxyPluginRequest('PATCH', request, params); }
export async function DELETE(request: Request, { params }: Params): Promise<Response> { return proxyPluginRequest('DELETE', request, params); }
