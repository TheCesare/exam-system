import { NextRequest, NextResponse } from 'next/server'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Msan@01245893610'
const USER_PASSWORD = process.env.USER_PASSWORD || 'u12345'

export async function POST(request: NextRequest) {
  try {
    const { password, role } = await request.json()
    
    if (role === 'user') {
      if (password === USER_PASSWORD) {
        return NextResponse.json({ success: true, role: 'user' })
      }
      return NextResponse.json({ success: false, message: 'Wrong password' }, { status: 401 })
    }

    if (password === ADMIN_PASSWORD) {
      return NextResponse.json({ success: true, role: 'admin' })
    }
    return NextResponse.json({ success: false, message: 'Wrong password' }, { status: 401 })
  } catch {
    return NextResponse.json({ success: false, message: 'Error' }, { status: 500 })
  }
}