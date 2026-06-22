import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Admin password - in production use env variable
const ADMIN_PASSWORD = 'admin123'

export async function POST(request: NextRequest) {
  try {
    const { password } = await request.json()
    if (password === ADMIN_PASSWORD) {
      return NextResponse.json({ success: true, role: 'admin' })
    }
    return NextResponse.json({ success: false, message: 'كلمة السر غلط' }, { status: 401 })
  } catch {
    return NextResponse.json({ success: false, message: 'Error' }, { status: 500 })
  }
}