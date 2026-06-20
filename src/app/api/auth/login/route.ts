import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { username, password } = body;
        
        const adminUser = process.env.ADMIN_USERNAME || 'admin';
        const adminPass = process.env.ADMIN_PASSWORD || 'password123';
        
        if (username === adminUser && password === adminPass) {
            const cookieStore = await cookies();
            const sessionValue = Buffer.from(`${adminUser}:${adminPass}`).toString('base64');
            
            cookieStore.set('trade_session', sessionValue, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                path: '/',
                maxAge: 60 * 60 * 24 * 7, // 1 week
            });
            
            return NextResponse.json({ success: true });
        }
        
        return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
    } catch {
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
}
