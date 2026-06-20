import { cookies } from 'next/headers';

export async function checkAuth(): Promise<boolean> {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'password123';
    
    const cookieStore = await cookies();
    const session = cookieStore.get('trade_session')?.value;
    
    const expectedSession = Buffer.from(`${username}:${password}`).toString('base64');
    return session === expectedSession;
}
