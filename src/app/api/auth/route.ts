import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Msan@01245893610'
const SETTINGS_ID = 'a0000000-a000-a000-a000-a00000000000'

export async function POST(request: NextRequest) {
  try {
    const { password, role, name } = await request.json()

    if (role === 'user') {
      // Check against supervisors list in settings
      const { data } = await supabase
        .from('distribution_results')
        .select('data')
        .eq('id', SETTINGS_ID)
        .single()

      const settings = (data?.data as Record<string, any>) || {}
      const supervisors: { id: string; name: string; password: string; permissions?: string[] }[] = settings.supervisors || []

      if (!name) {
        return NextResponse.json({ success: false, message: 'Please select your name' }, { status: 400 })
      }

      const supervisor = supervisors.find(s => s.name.toLowerCase() === name.toLowerCase() && s.password === password)
      if (supervisor) {
        return NextResponse.json({ success: true, role: 'user', name: supervisor.name, permissions: supervisor.permissions || [] })
      }
      return NextResponse.json({ success: false, message: 'Wrong password' }, { status: 401 })
    }

    // Admin login
    if (password === ADMIN_PASSWORD) {
      return NextResponse.json({ success: true, role: 'admin' })
    }
    return NextResponse.json({ success: false, message: 'Wrong password' }, { status: 401 })
  } catch {
    return NextResponse.json({ success: false, message: 'Error' }, { status: 500 })
  }
}