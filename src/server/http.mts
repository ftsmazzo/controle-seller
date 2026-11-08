export function publicUrl(path: string, request: Request): URL {
  const configured = process.env.APP_PUBLIC_URL;
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('APP_PUBLIC_URL é obrigatória para redirecionamentos em produção.');
  }
  const origin = configured ? new URL(configured).origin : new URL(request.url).origin;
  return new URL(path, origin);
}
