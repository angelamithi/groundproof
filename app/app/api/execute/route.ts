import { NextResponse } from 'next/server';
import { enoki } from '@/lib/enoki-server';

/** Submit a sponsored transaction once the worker has signed it. */
export async function POST(req: Request) {
  try {
    const { digest, signature } = (await req.json()) as { digest?: string; signature?: string };
    if (!digest || !signature) {
      return NextResponse.json({ error: 'digest and signature are required' }, { status: 400 });
    }
    const result = await enoki().executeSponsoredTransaction({ digest, signature });
    return NextResponse.json({ digest: result.digest });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
