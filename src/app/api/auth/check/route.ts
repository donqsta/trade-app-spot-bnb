import { NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth-helper';

export async function GET() {
    const isAuthorized = await checkAuth();
    return NextResponse.json({ authorized: isAuthorized });
}
